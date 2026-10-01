// 留灯 · SillyTavern 服务端插件
// 一、在 127.0.0.1 上开一个中继：酒馆 → 留灯 → Gemini。
//     酒馆那头断开时，留灯不跟着取消，继续把回复收完并存在内存里。
// 二、在 /api/plugins/liudeng/ 下给前端扩展提供取回接口（同源，不用额外暴露端口）。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

// 默认配置。要改的话复制 config.example.json 为 config.json 再改，config.json 不会进 git。
const DEFAULTS = {
    host: '127.0.0.1',
    port: 5010,
    upstream: 'https://generativelanguage.googleapis.com',
    keep: 10,                    // 内存里保留最近几条
    timeoutMs: 15 * 60 * 1000,   // 单次生成最长等多久
    notify: {
        mode: 'off',             // 'off' | 'bark' | 'webhook'
        barkUrl: '',
        webhookUrl: '',          // POST JSON {title, body, jobId}，可以接潮声通道
    },
};

function loadConfig() {
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.log('[留灯] config.json 读不了，用默认配置：', e.message);
    }
    const c = { ...DEFAULTS, ...user, notify: { ...DEFAULTS.notify, ...(user.notify || {}) } };
    c.host = '127.0.0.1'; // 中继只听本机，不对外
    if (process.env.LIUDENG_PORT) c.port = Number(process.env.LIUDENG_PORT);
    if (process.env.LIUDENG_UPSTREAM) c.upstream = process.env.LIUDENG_UPSTREAM;
    c.upstream = c.upstream.replace(/\/$/, '');
    return c;
}

const CONFIG = loadConfig();

// Gemini 原生 / OpenAI 兼容 / Claude 原生（中转站常见的三种）
const GEN_PATH = /generateContent|chat\/completions|\/messages(?:\?|$)/i;
// 中转站写法：http://127.0.0.1:5010/https://中转站地址/v1 ，前缀后面就是真正的上游
const INLINE = /^\/(https?):\/\/?([^/?#]+)(.*)$/i;
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive']);
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

const jobs = [];          // 新的在前
let pendingTag = null;    // 前端在生成开始时报来的「这是哪个聊天、什么类型」
let server = null;

const log = (...a) => console.log('[留灯]', ...a);

function takeTag() {
    if (pendingTag && Date.now() - pendingTag.at < 120_000) {
        const t = pendingTag;
        pendingTag = null;
        return t;
    }
    return null;
}

// 地址里带了上游就走那个，没带就走 config 里的 upstream
function route(url) {
    const m = url.match(INLINE);
    if (!m) return { target: CONFIG.upstream + url, host: CONFIG.upstream.replace(/^\w+:\/\//, '').split('/')[0], path: url };
    const path = m[3] || '/';
    return { target: `${m[1].toLowerCase()}://${m[2]}${path}`, host: m[2], path };
}

function newJob(url, host) {
    const job = {
        id: crypto.randomBytes(4).toString('hex'),
        host,
        model: (url.match(/models\/([^:?/]+)/) || [])[1] || '',
        startedAt: Date.now(),
        finishedAt: 0,
        status: 'running',     // running | done | failed | stopped
        downstreamGone: false, // 酒馆那头是否中途断开
        goneAt: 0,
        stopped: false,        // 用户点了停止，上游已掐掉
        ctrl: new AbortController(),
        claimed: false,        // 前端是否已经捞回
        tag: takeTag(),
        httpStatus: 0,
        text: '',
        reasoning: '',
        finish: '',
        error: '',
    };
    jobs.unshift(job);
    if (jobs.length > CONFIG.keep) jobs.length = CONFIG.keep;
    return job;
}

function pickReqHeaders(src) {
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        if (v == null || DROP_REQ.has(k.toLowerCase())) continue;
        out[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return out;
}

// 从原始响应里拆出正文、思考、结束原因。兼容 Gemini 原生、OpenAI 兼容、Claude 原生格式，流式非流式都行。
function extract(raw, isSSE) {
    const objs = [];
    const t = raw.trim();
    if (isSSE || t.startsWith('data:')) {
        for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const p = line.slice(5).trim();
            if (!p || p === '[DONE]') continue;
            try { objs.push(JSON.parse(p)); } catch { /* 半行，跳过 */ }
        }
    } else if (t) {
        try {
            const j = JSON.parse(t);
            Array.isArray(j) ? objs.push(...j) : objs.push(j);
        } catch { /* 不是 JSON */ }
    }

    let text = '', reasoning = '', finish = '';
    for (const o of objs) {
        if (o?.error) finish = 'ERROR: ' + (o.error.message || JSON.stringify(o.error)).slice(0, 200);
        if (o?.promptFeedback?.blockReason) finish = 'BLOCKED: ' + o.promptFeedback.blockReason;

        const cand = o?.candidates?.[0];
        if (cand) {
            for (const p of cand.content?.parts ?? []) {
                if (typeof p.text !== 'string') continue;
                if (p.thought) reasoning += p.text;
                else text += p.text;
            }
            if (cand.finishReason) finish = cand.finishReason;
        }

        const ch = o?.choices?.[0];
        if (ch) {
            const d = ch.delta ?? ch.message ?? {};
            if (typeof d.content === 'string') text += d.content;
            const r = d.reasoning_content ?? d.reasoning;
            if (typeof r === 'string') reasoning += r;
            if (ch.finish_reason) finish = ch.finish_reason;
        }

        // Claude：流式是一块块 content_block_delta，非流式是 content 数组
        const blocks = o?.type === 'message' && Array.isArray(o.content) ? o.content
            : o?.type === 'content_block_start' ? [o.content_block]
            : o?.type === 'content_block_delta' ? [o.delta] : [];
        for (const b of blocks) {
            if (typeof b?.text === 'string') text += b.text;
            if (typeof b?.thinking === 'string') reasoning += b.thinking;
        }
        const stop = o?.stop_reason ?? (o?.type === 'message_delta' ? o.delta?.stop_reason : null);
        if (stop) finish = /^(end_turn|stop_sequence)$/.test(stop) ? 'stop' : stop;
    }
    return { text, reasoning, finish };
}

async function notify(job) {
    const n = CONFIG.notify;
    if (n.mode === 'off') return;
    const okFinish = !job.finish || /^stop$/i.test(job.finish);
    const title = job.status === 'done' && job.text ? '留灯：回复写好了' : '留灯：这次没拿到正文';
    const body = job.status === 'done' && job.text
        ? `${job.text.length} 字${okFinish ? '' : '，结束原因 ' + job.finish}。回酒馆就能捞回。`
        : (job.error || job.finish || `HTTP ${job.httpStatus}`).slice(0, 120);
    try {
        if (n.mode === 'bark' && n.barkUrl) {
            await fetch(`${n.barkUrl.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=liudeng`);
        } else if (n.mode === 'webhook' && n.webhookUrl) {
            await fetch(n.webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title, body, jobId: job.id }),
            });
        }
    } catch (e) {
        log('通知没发出去：', e.message);
    }
}

function settle(job, raw, isSSE) {
    const { text, reasoning, finish } = extract(raw, isSSE);
    job.text = text;
    job.reasoning = reasoning;
    job.finish = job.finish || finish;
    job.finishedAt = Date.now();
    job.status = job.stopped ? 'stopped'
        : job.httpStatus >= 200 && job.httpStatus < 300 && !job.error ? 'done' : 'failed';
    if (job.status === 'failed' && !job.error) job.error = raw.slice(0, 300);
    const secs = Math.round((job.finishedAt - job.startedAt) / 1000);
    const kept = job.downstreamGone && !job.stopped;
    log(`#${job.id} ${job.host} ${job.status}，${text.length} 字，${secs}s${kept ? '（酒馆中途断开，已留存）' : ''}`);
    if (kept && job.tag?.type !== 'quiet') notify(job);
}

async function handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const { target, host, path } = route(req.url);
    const job = req.method === 'POST' && GEN_PATH.test(path) ? newJob(path, host) : null;
    let gone = false;
    res.on('close', () => {
        if (res.writableEnded) return;
        gone = true;
        if (job && job.status === 'running') {
            job.downstreamGone = true;
            job.goneAt = Date.now();
            log(`#${job.id} 酒馆那头断了，继续收`);
        }
    });

    // 超时和「用户点了停止」都走这一个开关
    const ctrl = job ? job.ctrl : new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`超过 ${Math.round(CONFIG.timeoutMs / 1000)}s 还没收完`)), CONFIG.timeoutMs);

    let upstream;
    try {
        upstream = await fetch(target, {
            method: req.method,
            headers: pickReqHeaders(req.headers),
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
            signal: ctrl.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        if (job) {
            job.error = '连不上上游：' + (e?.message || e);
            settle(job, '', false);
        }
        if (!gone) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '留灯连不上上游：' + (e?.message || e) } }));
        }
        return;
    }

    if (job) job.httpStatus = upstream.status;
    const headers = {};
    upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k)) headers[k] = v; });
    if (!gone) res.writeHead(upstream.status, headers);
    const isSSE = (upstream.headers.get('content-type') || '').includes('event-stream');

    const decoder = new TextDecoder();
    let raw = '';
    try {
        if (upstream.body) {
            const reader = upstream.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (job) raw += decoder.decode(value, { stream: true });
                if (!gone && !res.destroyed) res.write(value);
            }
        }
        if (job) raw += decoder.decode();
    } catch (e) {
        if (job) job.error = '读取上游中断：' + (e?.message || e);
    }
    if (!gone && !res.destroyed) res.end();
    clearTimeout(timer);
    if (job) settle(job, raw, isSSE);
}

function summary(j) {
    return {
        id: j.id,
        model: j.model,
        status: j.status,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        downstreamGone: j.downstreamGone,
        claimed: j.claimed,
        tag: j.tag ? { chatId: j.tag.chatId, type: j.tag.type } : null,
        chars: j.text.length,
        finish: j.finish,
        error: j.error ? j.error.slice(0, 200) : '',
        preview: j.text.slice(-50),
    };
}

export async function init(router) {
    server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
            log('中继异常：', e);
            try { res.destroy(); } catch { /* ignore */ }
        });
    });
    server.on('error', (e) => log('中继没起来：', e.message));
    server.listen(CONFIG.port, CONFIG.host, () => {
        log(`中继就绪 http://${CONFIG.host}:${CONFIG.port} → ${CONFIG.upstream}`);
    });

    router.get('/jobs', (req, res) => res.json(jobs.map(summary)));

    router.get('/jobs/:id', (req, res) => {
        const j = jobs.find((x) => x.id === req.params.id);
        if (!j) return res.status(404).json({ error: 'not found' });
        res.json({ ...summary(j), text: j.text, reasoning: j.reasoning, baseLen: j.tag?.baseLen || 0, baseTail: j.tag?.baseTail || '' });
    });

    router.post('/jobs/:id/claim', (req, res) => {
        const j = jobs.find((x) => x.id === req.params.id);
        if (!j) return res.status(404).json({ error: 'not found' });
        j.claimed = true;
        res.json({ ok: true });
    });

    // 用户点了停止：掐掉这个聊天里刚断开（或还没断开）的那条，免得中转站把整条收完再计费。
    // 断开超过几秒的是切后台留下来的，不动；别的插件的 quiet 生成也不动。
    router.post('/stop', (req, res) => {
        const chatId = String(req.query?.chatId || '');
        let n = 0;
        for (const j of jobs) {
            if (j.status !== 'running' || !j.tag || j.tag.type === 'quiet' || j.tag.chatId !== chatId) continue;
            if (j.downstreamGone && Date.now() - j.goneAt > 5000) continue;
            j.stopped = true;
            j.claimed = true;
            j.ctrl.abort(new Error('用户停止'));
            n++;
        }
        if (n) log(`点了停止，掐掉 ${n} 条上游`);
        res.json({ ok: true, stopped: n });
    });

    // 前端在 GENERATION_STARTED 时报到，参数走 query，免得依赖 body 解析
    router.post('/tag', (req, res) => {
        const q = req.query || {};
        pendingTag = {
            chatId: String(q.chatId || ''),
            type: String(q.type || 'normal'),
            baseLen: Number(q.baseLen) || 0,
            baseTail: String(q.baseTail || '').slice(-80),
            at: Date.now(),
        };
        // 报到比请求晚到的情况：挂到刚开始、还没标签的那条上
        const fresh = jobs.find((j) => !j.tag && j.status === 'running' && Date.now() - j.startedAt < 5000);
        if (fresh) fresh.tag = takeTag();
        res.json({ ok: true });
    });
}

export async function exit() {
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
}

export const info = {
    id: 'liudeng',
    name: '留灯',
    description: '生成中继：酒馆前端断开后继续收完回复，回来后可以捞回。',
};
