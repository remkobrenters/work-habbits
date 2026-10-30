// Renders docs/previews/*.png from docs/previews/previews.html, each cropped to its scene, with headless
// Chrome over the DevTools pipe. No dependencies. Usage: node scripts/render_previews.mjs [chrome binary]
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const SCENES = ['panel-green', 'panel-orange', 'panel-red', 'panel-snoozed', 'panel-unavailable', 'panel-icons',
    'menu-dark', 'menu-light'];
const root = fileURLToPath(new URL('..', import.meta.url));
const page = pathToFileURL(join(root, 'docs/previews/previews.html')).href;
const profile = mkdtempSync(join(tmpdir(), 'work-habbits-previews-'));
const chrome = spawn(process.argv[2] ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--hide-scrollbars', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
{stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});

// The pipe carries NUL-terminated JSON messages: commands on fd 3, replies and events on fd 4.
let nextId = 0;
let buffer = '';
const pending = new Map();
const listeners = new Set();
chrome.stdio[4].on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (!call) for (const listener of listeners) listener(message);
        else if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
    }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    chrome.stdio[3].write(`${JSON.stringify({id, method, params, sessionId})}\0`);
});
const once = (method, sessionId) => new Promise(resolve => {
    const listener = message => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        listeners.delete(listener);
        resolve(message.params);
    };
    listeners.add(listener);
});

try {
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {width: 800, height: 1200, deviceScaleFactor: 2, mobile: false},
        sessionId);
    for (const scene of SCENES) {
        // The query string forces a full load; the fragment selects the scene through :target.
        const loaded = once('Page.loadEventFired', sessionId);
        await send('Page.navigate', {url: `${page}?${scene}#${scene}`}, sessionId);
        await loaded;
        await send('Runtime.evaluate', {expression: 'document.fonts.ready.then(() => true)', awaitPromise: true}, sessionId);
        const {result} = await send('Runtime.evaluate', {returnByValue: true,
            expression: "document.querySelector('section:target > *').getBoundingClientRect().toJSON()"}, sessionId);
        const {x, y, width, height} = result.value;
        const {data} = await send('Page.captureScreenshot', {format: 'png', clip: {x, y, width, height, scale: 1}},
            sessionId);
        writeFileSync(join(root, 'docs/previews', `${scene}.png`), Buffer.from(data, 'base64'));
        console.log(`docs/previews/${scene}.png`);
    }
} finally {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
    rmSync(profile, {recursive: true, force: true});
}
