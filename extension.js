// 留灯 · 前端扩展
// 1) 生成开始时告诉服务端「这是哪个聊天、什么类型」
// 2) 切回酒馆时检查有没有没收到的回复，有就提示捞回
// 3) 可选的 iOS 保活：近乎无声的音频循环，被打断后回来自动续上

const API = '/api/plugins/liudeng';
const ctx = () => SillyTavern.getContext();

const offered = new Set();
let pollTimer = null;
let regexMod = null;
let scriptMod = null;
let keepAudio = null;
let keepWanted = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secsSince = (t) => Math.max(0, Math.round((Date.now() - t) / 1000));
const sticky = { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false };

function timeout(ms) {
    try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

async function api(path, init = {}) {
    const r = await fetch(API + path, { ...init, headers: ctx().getRequestHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

const claim = (id) => api(`/jobs/${id}/claim`, { method: 'POST', body: '{}' }).catch(() => {});

// ---------- 生成开始时报到 ----------

function onGenerationStarted(type, _opts, dryRun) {
    if (dryRun) return;
    const c = ctx();
    const q = new URLSearchParams({ chatId: c.getCurrentChatId?.() ?? '', type: type || 'normal' });
    if (type === 'continue') {
        const m = c.chat.at(-1)?.mes ?? '';
        q.set('baseLen', String(m.length));
        q.set('baseTail', m.slice(-60));
    }
    // 不等它回来：酒馆要等所有监听器跑完才发请求，等的话每次生成（包括别的插件的）都要多一个手机到 VPS 的来回。
    // 报到偶尔比请求晚到也没事，服务端会补挂上。
    fetch(`${API}/tag?${q}`, { method: 'POST', headers: c.getRequestHeaders(), body: '{}', signal: timeout(5000) })
        .catch(() => { /* 插件没开也不影响正常生成 */ });
}

// 点了停止就是真不要了，让服务端也别再收，不然中转站照样按整条计费
function onGenerationStopped() {
    const c = ctx();
    const q = new URLSearchParams({ chatId: c.getCurrentChatId?.() ?? '' });
    fetch(`${API}/stop?${q}`, { method: 'POST', headers: c.getRequestHeaders(), body: '{}', signal: timeout(5000) })
        .catch(() => {});
}

// ---------- 检查与提示 ----------

async function check({ manual = false } = {}) {
    let list;
    try {
        list = await api('/jobs');
    } catch {
        if (manual) toastr.error('连不上留灯服务端插件。确认 config.yaml 里 enableServerPlugins 为 true，并已重启酒馆。', '留灯');
        return;
    }

    const chatId = ctx().getCurrentChatId?.();
    const real = (j) => j.tag?.type !== 'quiet';
    const mine = (j) => real(j) && j.tag?.chatId && j.tag.chatId === chatId;
    const orphanOf = (j) => j.status !== 'running' && j.downstreamGone && !j.claimed;

    const orphan = list.find((j) => orphanOf(j) && mine(j));
    if (orphan) return offer(orphan, manual);

    const running = list.find((j) => j.status === 'running' && j.downstreamGone && mine(j));
    if (running) {
        if (manual || !offered.has('run:' + running.id)) {
            offered.add('run:' + running.id);
            toastr.info(`后台还在写，已经 ${secsSince(running.startedAt)} 秒。写完会在这里提示。`, '留灯');
        }
        startPolling();
        return;
    }

    if (!manual) return;

    const elsewhere = list.find((j) => orphanOf(j) && real(j) && j.tag?.chatId && j.tag.chatId !== chatId);
    if (elsewhere) {
        toastr.info(`「${esc(elsewhere.tag.chatId)}」里有一条没收到的回复，切到那个聊天再捞回。`, '留灯', { escapeHtml: false });
        return;
    }
    const latest = list.find((j) => j.status === 'done' && j.chars > 0 && real(j) && (!j.tag?.chatId || j.tag.chatId === chatId));
    if (latest) return offer(latest, true);
    toastr.info('现在没有可以捞回的回复。', '留灯');
}

function offer(job, force) {
    if (!force && offered.has(job.id)) return;
    offered.add(job.id);
    const when = new Date(job.finishedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (job.status === 'failed' || !job.chars) {
        toastr.warning(`${when} 那次生成没拿到正文：${esc(job.error || job.finish || '空回复')}`, '留灯', sticky);
        claim(job.id);
        return;
    }
    const note = job.claimed ? '（已经捞回过）' : job.downstreamGone ? '' : '（当时已送达）';
    const cut = job.finish && !/^stop$/i.test(job.finish) ? `<br>结束原因：${esc(job.finish)}` : '';
    toastr.info(
        `${when} 写好了 ${job.chars} 字${note}<br>…${esc(job.preview)}${cut}<br>轻点这里捞回`,
        '留灯',
        { ...sticky, onclick: () => recover(job.id) },
    );
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
        if (document.hidden) return;
        const chatId = ctx().getCurrentChatId?.();
        let list;
        try { list = await api('/jobs'); } catch { return; }
        const still = list.some((j) => j.status === 'running' && j.downstreamGone && j.tag?.chatId === chatId);
        if (!still) {
            clearInterval(pollTimer);
            pollTimer = null;
            check();
        }
    }, 4000);
}

// ---------- 捞回 ----------

async function recover(id) {
    const c = ctx();
    if (c.groupId) return toastr.warning('群聊里暂时不能捞回。', '留灯');
    if (c.characterId === undefined) return toastr.warning('先打开对应的角色聊天，再捞回。', '留灯');

    let job;
    try {
        job = await api(`/jobs/${id}`);
    } catch (e) {
        return toastr.error('取回失败：' + e.message, '留灯');
    }
    if (job.tag?.chatId && job.tag.chatId !== c.getCurrentChatId?.()) {
        return toastr.warning(`这条属于「${esc(job.tag.chatId)}」，切过去再捞回。`, '留灯', { escapeHtml: false });
    }

    let text = job.text;
    try {
        regexMod ??= await import('../../regex/engine.js');
        text = regexMod.getRegexedString(text, regexMod.regex_placement.AI_OUTPUT);
    } catch (e) {
        console.warn('[留灯] 正则没有应用', e);
    }
    try { scriptMod ??= await import('../../../../script.js'); } catch { /* 用兜底时间戳 */ }
    const ts = scriptMod?.getMessageTimeStamp?.() ?? new Date().toISOString();
    const type = job.tag?.type || 'normal';

    if (type === 'impersonate') {
        const ta = document.getElementById('send_textarea');
        if (ta) {
            ta.value = text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await claim(id);
        return toastr.success('已捞回到输入框。', '留灯');
    }

    const extra = job.reasoning ? { reasoning: job.reasoning } : {};
    const swipeInfo = { send_date: ts, gen_started: new Date(job.startedAt), gen_finished: new Date(job.finishedAt), extra };
    const chat = c.chat;
    const last = chat.at(-1);
    const lastIsAI = last && !last.is_user && !last.is_system;
    let index = chat.length - 1;
    let evtType = 'normal';

    if (lastIsAI) {
        if (!Array.isArray(last.swipes) || !last.swipes.length) {
            last.swipes = [last.mes ?? ''];
            last.swipe_id = 0;
        }
        last.swipe_info ??= [];
        while (last.swipe_info.length < last.swipes.length) {
            last.swipe_info.push({ send_date: last.send_date, extra: structuredClone(last.extra ?? {}) });
        }
    }

    if (type === 'continue' && lastIsAI) {
        // 续写：切掉中断时可能残留的半截续写，再接上完整的
        let base = last.mes ?? '';
        if (job.baseLen && base.length >= job.baseLen && base.slice(0, job.baseLen).endsWith(job.baseTail)) {
            base = base.slice(0, job.baseLen);
        }
        last.mes = base + text;
        last.swipes[last.swipe_id] = last.mes;
        evtType = 'continue';
    } else if (lastIsAI && (type === 'swipe' || isPartial(last.mes, text, job.text))) {
        if (isPartial(last.mes, text, job.text)) {
            last.swipes[last.swipe_id] = text;
            last.swipe_info[last.swipe_id] = swipeInfo;
        } else {
            last.swipes.push(text);
            last.swipe_info.push(swipeInfo);
            last.swipe_id = last.swipes.length - 1;
        }
        last.mes = text;
        last.send_date = ts;
        last.extra = { ...(last.extra ?? {}) };
        if (job.reasoning) last.extra.reasoning = job.reasoning;
        else delete last.extra.reasoning;
        evtType = type === 'swipe' ? 'swipe' : 'normal';
    } else {
        chat.push({
            name: c.name2,
            is_user: false,
            is_system: false,
            send_date: ts,
            mes: text,
            extra: { ...extra },
            swipes: [text],
            swipe_id: 0,
            swipe_info: [swipeInfo],
        });
        index = chat.length - 1;
    }

    await claim(id);
    // 照常走一遍收到回复的事件，让其他扩展（状态栏、挂账之类）把它当正常回复处理
    await c.eventSource.emit(c.event_types.MESSAGE_RECEIVED, index, evtType);
    await c.saveChat();
    await c.reloadCurrentChat();
    await c.eventSource.emit(c.event_types.CHARACTER_MESSAGE_RENDERED, index, evtType);
    toastr.success(`已捞回 ${job.chars} 字。`, '留灯');
}

// 最后一楼是中断时留下的半截（或空楼）吗
function isPartial(mes, regexed, raw) {
    const cur = (mes ?? '').trim();
    if (!cur || cur === '...') return true;
    return regexed.trim().startsWith(cur) || raw.trim().startsWith(cur);
}

// ---------- iOS 保活 ----------

// 10 分钟、8kHz、16 位单声道，振幅 ±2（约 -84dBFS，听不见），在内存里生成，不用另外托管文件
function quietWavUrl(seconds = 600, rate = 8000) {
    const n = seconds * rate;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const s = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE');
    s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, ((Math.random() * 5) | 0) - 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const keepOn = () => keepWanted && keepAudio && !keepAudio.paused;

function updateKeepLabel() {
    const el = document.querySelector('#liudeng_keep span');
    if (el) el.textContent = keepOn() ? '关闭保活' : '开启保活';
}

function toggleKeep() {
    if (keepOn()) {
        keepWanted = false;
        keepAudio.pause();
        updateKeepLabel();
        toastr.info('保活已关闭。', '留灯');
        return;
    }
    if (!keepAudio) {
        keepAudio = new Audio(quietWavUrl());
        keepAudio.loop = true;
        keepAudio.setAttribute('playsinline', '');
        keepAudio.addEventListener('play', updateKeepLabel);
        keepAudio.addEventListener('pause', () => {
            updateKeepLabel();
            if (keepWanted && !document.hidden) keepAudio.play().catch(() => {});
        });
    }
    keepWanted = true;
    // 必须在点击的同一个调用里 play，iOS 才认
    keepAudio.play().then(() => {
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.metadata = new MediaMetadata({ title: '留灯', artist: '酒馆在后台' }); } catch { /* ignore */ }
        }
        updateKeepLabel();
        toastr.success('保活已开启，可以切到后台了。', '留灯');
    }).catch((e) => {
        keepWanted = false;
        updateKeepLabel();
        toastr.error('系统没让播放：' + e.message, '留灯');
    });
}

function onVisible() {
    if (document.hidden) return;
    if (keepWanted && keepAudio?.paused) {
        keepAudio.play().catch(() => {
            toastr.info('保活被别的声音打断了，轻点这里重新开启。', '留灯', { onclick: toggleKeep });
        });
    }
    check();
}

// ---------- 挂载 ----------

function addMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('liudeng_catch')) return;
    menu.insertAdjacentHTML('beforeend', `
        <div id="liudeng_keep" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-lightbulb extensionsMenuExtensionButton"></div><span>开启保活</span>
        </div>
        <div id="liudeng_catch" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-fish extensionsMenuExtensionButton"></div><span>捞回回复</span>
        </div>`);
    document.getElementById('liudeng_keep').addEventListener('click', toggleKeep);
    document.getElementById('liudeng_catch').addEventListener('click', () => check({ manual: true }));
}

jQuery(() => {
    const { eventSource, event_types } = ctx();
    addMenu();
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    // iOS 杀掉页面后重开、或者切换聊天时，都检查一次
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(check, 800));
    document.addEventListener('visibilitychange', onVisible);
});
