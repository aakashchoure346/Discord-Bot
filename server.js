const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const LOGS_FILE = path.join(__dirname, 'bot_logs.json');
const RULES_FILE = path.join(__dirname, 'Instant Funding.txt');

const TOTAL_ACCOUNTS = 10;
let botTimer = null; 
let isProcessing = false;

// --- Helper Functions ---
function getTradingDayStr() {
    const d = new Date(Date.now()); 
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1).toString().padStart(2, '0') + '-' + d.getUTCDate().toString().padStart(2, '0');
}

function getISTTimeStr() {
    const d = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    let hours = d.getUTCHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; 
    return hours.toString().padStart(2, '0') + ':' + d.getUTCMinutes().toString().padStart(2, '0') + ':' + d.getUTCSeconds().toString().padStart(2, '0') + ' ' + ampm;
}

function readJSON(file, defaultData) {
    if (!fs.existsSync(file)) { writeJSON(file, defaultData); return defaultData; }
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } 
    catch (e) { return defaultData; }
}

function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function addLog(status, accountIndex, targetUser, message, aiReply = "") {
    let logs = readJSON(LOGS_FILE, []);
    logs.unshift({ time: getISTTimeStr(), status, accountIndex, targetUser, message, aiReply });
    if (logs.length > 150) logs = logs.slice(0, 150);
    writeJSON(LOGS_FILE, logs);
}

function collectRequestData(request, callback) {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => {
        try { callback(JSON.parse(body)); } 
        catch (e) { callback({}); }
    });
}

const defaultConfig = {
    isActive: false, 
    channelId: "", 
    providerType: "freemodel",
    apiUrl: "https://api.freemodel.dev/v1/chat/completions", 
    apiModel: "gpt-5.5",
    apiKeys: "", 
    ignoreIds: "",
    replyDelayMin: 3, 
    accounts: Array(TOTAL_ACCOUNTS).fill({ token: "", dailyLimit: 20, isActive: true })
};

function getSafeConfig() {
    let conf = readJSON(CONFIG_FILE, defaultConfig);
    if (!conf.accounts || !Array.isArray(conf.accounts)) conf.accounts = [];
    while (conf.accounts.length < TOTAL_ACCOUNTS) {
        conf.accounts.push({ token: "", dailyLimit: 20, isActive: true });
    }
    conf.accounts.forEach(acc => {
        if(acc.isActive === undefined) acc.isActive = true;
    });
    return conf;
}

function getSafeState() {
    let def = { 
        date: getTradingDayStr(), 
        counts: {}, 
        nextAvailableTime: {}, 
        nextRunTime: null, 
        nextAccountIndex: null, 
        accountNames: {}, 
        lastUsedAccountIndex: -1 
    };
    return readJSON(STATE_FILE, def);
}

readJSON(LOGS_FILE, []);

// --- Rock Solid Network Retry Layer ---
// FIX: Dramatically increased timeout for slow proxy servers
async function fetchWithRetry(url, options, timeout = 90000, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(id);
            if (response.status >= 500 && response.status <= 599) {
                if (i < maxRetries - 1) {
                    await response.text().catch(()=>null); 
                    await new Promise(r => setTimeout(r, 3000)); 
                    continue; 
                }
            }
            return response;
        } catch (e) {
            clearTimeout(id);
            if (i === maxRetries - 1) throw e; 
            await new Promise(r => setTimeout(r, 3000)); 
        }
    }
}

// --- Sync Profile Usernames Automatically ---
async function fetchAccountProfiles() {
    let conf = getSafeConfig();
    let st = getSafeState();
    if (!st.accountNames) st.accountNames = {};
    let updated = false;

    for (let i = 0; i < TOTAL_ACCOUNTS; i++) {
        let acc = conf.accounts[i];
        if (acc && acc.token && acc.token.trim() !== "") {
            try {
                let res = await fetchWithRetry('https://discord.com/api/v9/users/@me', { headers: { 'Authorization': acc.token.trim() } });
                if (res.ok) {
                    let data = await res.json();
                    let name = data.global_name || data.username;
                    if (st.accountNames[i] !== name) {
                        st.accountNames[i] = name;
                        updated = true;
                    }
                } else {
                    await res.text().catch(()=>null); 
                    if (res.status === 401) {
                        st.accountNames[i] = "🚨 Token Error (401)";
                        updated = true;
                    }
                }
            } catch (e) {}
        } else {
            if (st.accountNames[i]) {
                delete st.accountNames[i];
                updated = true;
            }
        }
    }
    if (updated) writeJSON(STATE_FILE, st);
}

// --- Fetch Messages ---
async function fetchRecentMessages(channelId, token) {
    const res = await fetchWithRetry(`https://discord.com/api/v9/channels/${channelId}/messages?limit=15`, { headers: { 'Authorization': token.trim() } });
    if (!res.ok) {
        await res.text().catch(()=>null);
        const errObj = new Error(`Discord messages unreachable: ${res.status}`);
        errObj.statusCode = res.status;
        throw errObj;
    }
    return await res.json();
}

// --- Smart Unified Brain Layer ---
async function getUniversalReply(chatHistory, targetMessageText, config, accountIndex) {
    let keysRaw = config.apiKeys || "";
    const keys = keysRaw.replace(/\\r/g, '').replace(/\\n/g, ',').split(',').map(k => k.trim()).filter(k => k !== "");
    if(keys.length === 0) throw new Error("No API Keys configured inside global station.");

    let knowledgeBase = "No rules configured.";
    if (fs.existsSync(RULES_FILE)) {
        knowledgeBase = fs.readFileSync(RULES_FILE, 'utf8');
        if (knowledgeBase.length > 6000) {
            knowledgeBase = knowledgeBase.substring(0, 6000) + "\\n...[Content Truncated]";
        }
    }

    const personas = [
        "Persona: The Technician. Highly analytical. Explain your reasoning logically.",
        "Persona: The Chill Trader. Casual, relaxed. Uses 'man' or 'dude'. Avoids emojis.",
        "Persona: The Risk Manager. Always emphasizes protecting capital and smart limits.",
        "Persona: The Data Nerd. Talk about percentages, drawdown rules, and scaling.",
        "Persona: The Realist. Down-to-earth, points out trading is hard work but consistency pays off.",
        "Persona: The Swing Trader. Focus on higher timeframes and holding trades patiently.",
        "Persona: The Zen Trader. Focus purely on psychology, emotions, and keeping a clear mind.",
        "Persona: The Opportunist. Look for clear setups. Talk about waiting for the right moment.",
        "Persona: The Disciplined Scalper. Fast-paced but calculated. Mention taking quick profits.",
        "Persona: The Mentor. Supportive and encouraging. Give advice like a senior trader."
    ];
    
    const activePersona = personas[accountIndex % TOTAL_ACCOUNTS];

    const systemPrompt = `You are a real crypto and forex trader chatting casually on a Discord server. 
    You must ONLY speak in ENGLISH. Never say you are an AI, bot, or support staff.
    
    YOUR PERSONALITY: ${activePersona}
    
    STRICT LOGIC:
    1. If the target message asks for backend support (e.g., "check my account", "IP ban", "slippage check"), you MUST output exactly: CANCEL_MESSAGE
    2. If the user asks about an Instant Funding rule, answer naturally using ONLY the KNOWLEDGE BASE below.
    3. For general chat (trading setups, psychology, market talk), reply naturally like a fellow trader.

    --- START OF INSTANT FUNDING KNOWLEDGE BASE ---
    ${knowledgeBase}
    --- END OF KNOWLEDGE BASE ---

    CONVERSATION RULES:
    - NO RANDOM GREETINGS: Do not say "Good morning" unless they greeted you.
    - DIRECT REPLY: Acknowledge the exact topic in the TARGET MESSAGE. Stay relevant.
    - LENGTH: Write 2 to 3 engaging sentences (20-45 words). Make it feel human. DO NOT give robotic 3-word answers.
    
    Recent Chat for Context:
    ${chatHistory}
    
    TARGET MESSAGE TO REPLY TO DIRECTLY:
    "${targetMessageText}"`;

    let lastError = "";

    for(let i = 0; i < keys.length; i++) {
        let key = keys[i];
        try {
            let replyText = "";
            let targetUrl = config.apiUrl ? config.apiUrl.trim() : "";
            let targetModel = config.apiModel ? config.apiModel.trim() : "";
            let headers = { 'Content-Type': 'application/json' };
            let payload = {};

            if (config.providerType === 'gemini' || key.startsWith('AIza')) {
                let m = targetModel.includes('gemini') ? targetModel : "gemini-1.5-flash";
                let url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
                payload = { contents: [{ parts: [{ text: systemPrompt }] }] };
                
                const res = await fetchWithRetry(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
                if(!res.ok) {
                    let errTxt = await res.text().catch(()=>"");
                    throw new Error(`Gemini Server Error: ${res.status} ${errTxt.substring(0, 50)}`);
                }
                const data = await res.json();
                if(data.error) throw new Error(data.error.message);
                replyText = data.candidates[0].content.parts[0].text.trim();
            } 
            else if (config.providerType === 'claude') {
                targetUrl = "https://api.anthropic.com/v1/messages";
                payload = {
                    model: targetModel || "claude-3-haiku-20240307",
                    max_tokens: 150,
                    system: systemPrompt,
                    messages: [{ role: "user", content: "Execute your instructions and reply." }]
                };
                const res = await fetchWithRetry(targetUrl, {
                    method: 'POST',
                    headers: {
                        'x-api-key': key,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                        'dangerously-allow-html': 'true'
                    },
                    body: JSON.stringify(payload)
                });
                if(!res.ok) throw new Error(`Claude Error ${res.status}`);
                const data = await res.json();
                replyText = data.content[0].text;
            }
            else {
                if (!targetUrl) {
                    if (config.providerType === 'openrouter') targetUrl = "https://openrouter.ai/api/v1/chat/completions";
                    else if (config.providerType === 'freemodel') targetUrl = "https://api.freemodel.dev/v1/chat/completions";
                    else targetUrl = "https://api.openai.com/v1/chat/completions";
                }
                if(!targetModel) targetModel = "gpt-3.5-turbo";

                headers['Authorization'] = `Bearer ${key}`;
                if (config.providerType === 'openrouter') {
                    headers['HTTP-Referer'] = 'https://railway.app';
                    headers['X-Title'] = 'AI Station';
                }
                
                payload = {
                    model: targetModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: `Execute your instructions and reply.` }
                    ]
                };

                const res = await fetchWithRetry(targetUrl, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
                if(!res.ok) {
                    let errTxt = await res.text().catch(()=>"");
                    throw new Error(`API Provider Error: ${res.status} ${errTxt.substring(0, 80)}`);
                }
                const data = await res.json();
                if(data.error) throw new Error(data.error.message);
                replyText = data.choices[0].message.content.trim();
            }

            return replyText; 
        } catch (e) {
            let cleanMsg = e.message;
            if(e.name === 'AbortError') cleanMsg = "API Timeout (Server overloaded)";
            else if(cleanMsg.includes('fetch failed')) cleanMsg = `Network Drop (Failed to connect) - ${cleanMsg}`;
            lastError = cleanMsg;
            addLog("Warning", "System", "None", `Key ${i+1} Router Error: ${cleanMsg}`);
        }
    }
    throw new Error(lastError);
}

// --- Send Discord Reply ---
async function sendDiscordReply(replyText, targetMessageId, channelId, token) {
    const payload = { content: replyText, message_reference: { message_id: targetMessageId } };
    const res = await fetchWithRetry(`https://discord.com/api/v9/channels/${channelId}/messages`, {
        method: 'POST', headers: { 'Authorization': token.trim(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) {
        let errTxt = await res.text().catch(()=>"");
        throw new Error(`Discord post failed: ${res.status} ${errTxt.substring(0,50)}`);
    }
}

// --- SCHEDULER ---
function scheduleNextRun(forceRun = false) {
    const config = getSafeConfig();
    let state = getSafeState();

    if (!config.isActive) {
        state.nextRunTime = null; state.nextAccountIndex = null;
        writeJSON(STATE_FILE, state); return;
    }

    if (state.date !== getTradingDayStr()) {
        state = { 
            date: getTradingDayStr(), 
            counts: {}, 
            nextAvailableTime: {}, 
            nextRunTime: null, 
            nextAccountIndex: null, 
            accountNames: state.accountNames || {},
            lastUsedAccountIndex: -1 
        };
        addLog("Info", "System", "None", "5:30 AM (IST) Cross ho gaya! Saare counts reset.");
    }

    if (forceRun) {
        state.nextRunTime = Date.now() + 1000;
        writeJSON(STATE_FILE, state);
        if(botTimer) clearTimeout(botTimer);
        botTimer = setTimeout(runBotCycle, 1000);
        return;
    }

    const now = Date.now();
    let nextIdx = null;
    let soonestReadyTime = Infinity;
    
    let startIndex = (state.lastUsedAccountIndex !== undefined && state.lastUsedAccountIndex !== null) ? state.lastUsedAccountIndex : -1;

    for (let offset = 1; offset <= TOTAL_ACCOUNTS; offset++) {
        let i = (startIndex + offset) % TOTAL_ACCOUNTS;
        let acc = config.accounts[i];

        if (!acc || !acc.isActive || !acc.token || acc.token.trim() === "") continue;

        const count = state.counts[`acc_${i}`] || 0;
        if (count >= acc.dailyLimit) continue;

        const nextAvail = state.nextAvailableTime[`acc_${i}`] || 0;

        if (now >= nextAvail) {
            nextIdx = i; 
            break;
        } else {
            if (nextAvail < soonestReadyTime) soonestReadyTime = nextAvail;
        }
    }

    if (nextIdx !== null) {
        state.nextAccountIndex = nextIdx;
        let customDelay = parseFloat(config.replyDelayMin) || 3;
        state.nextRunTime = Date.now() + (customDelay * 60000);
        writeJSON(STATE_FILE, state);
    } else if (soonestReadyTime !== Infinity) {
        state.nextAccountIndex = null;
        state.nextRunTime = soonestReadyTime + 5000; 
        writeJSON(STATE_FILE, state);
    } else {
        state.nextAccountIndex = null;
        state.nextRunTime = Date.now() + (60 * 60 * 1000); 
        writeJSON(STATE_FILE, state);
    }

    if(botTimer) clearTimeout(botTimer);
    if(state.nextRunTime) {
        botTimer = setTimeout(runBotCycle, Math.max(0, state.nextRunTime - Date.now()));
    }
}

// --- BOT MAIN ENGINE ---
async function runBotCycle() {
    if (isProcessing) return; 
    isProcessing = true;

    const config = getSafeConfig();
    let state = getSafeState();
    
    if (!config.isActive) { isProcessing = false; scheduleNextRun(); return; }

    let idx = state.nextAccountIndex;
    
    if (idx === null || idx === undefined) {
        let fallbackAccs = [];
        config.accounts.forEach((acc, i) => {
            if (acc.isActive && acc.token && (state.counts[`acc_${i}`] || 0) < acc.dailyLimit) fallbackAccs.push(i);
        });
        if (fallbackAccs.length === 0) { isProcessing = false; scheduleNextRun(); return; }
        idx = fallbackAccs[0];
    }

    const selectedAcc = config.accounts[idx];
    const rawIgnoreList = config.ignoreIds.replace(/\\r/g, '').split('\\n').map(id => id.trim()).filter(id => id !== "");

    let wipeState = readJSON(STATE_FILE, state);
    wipeState.nextAccountIndex = null;
    writeJSON(STATE_FILE, wipeState);

    try {
        let msgs = await fetchRecentMessages(config.channelId, selectedAcc.token);
        
        const STAFF_KEYWORDS = ['helper', 'mod', 'admin', 'staff', 'support', 'founder', 'ceo', 'owner', 'if'];
        msgs = msgs.filter(msg => {
            if(rawIgnoreList.includes(msg.author.id)) return false; 
            if(msg.author.bot) return false; 
            let uName = (msg.author.username + " " + (msg.author.global_name||"")).toLowerCase();
            for(let kw of STAFF_KEYWORDS) {
                if(uName.includes(kw)) return false;
            }
            return true;
        });

        if (msgs.length === 0) throw new Error("No safe chat target message found.");

        const sliceCount = Math.min(msgs.length, 5);
        const targetMsg = msgs[Math.floor(Math.random() * sliceCount)];
        
        let chatText = ""; 
        [...msgs].reverse().forEach(m => { chatText += m.author.username + ": " + m.content + "\\n"; });

        const aiResponse = await getUniversalReply(chatText, targetMsg.content, config, idx);
        
        if (aiResponse.includes("CANCEL_MESSAGE")) {
            addLog("Warning", idx, targetMsg.author.username, "Ignored Support Query. Moving to next account.");
            
            let skipState = getSafeState();
            if(!skipState.nextAvailableTime) skipState.nextAvailableTime = {};
            skipState.nextAvailableTime[`acc_${idx}`] = Date.now() + (5 * 60000); 
            skipState.lastUsedAccountIndex = idx; 
            
            writeJSON(STATE_FILE, skipState);
            isProcessing = false;
            scheduleNextRun();
            return;
        }

        const delay = Math.floor(Math.random() * 8000) + 5000; 
        addLog("Processing", idx, targetMsg.author.username, "Typing output... (" + Math.round(delay/1000) + "s wait)");
        
        setTimeout(async () => {
            try {
                await sendDiscordReply(aiResponse, targetMsg.id, config.channelId, selectedAcc.token);
                
                let freshState = getSafeState();
                if(!freshState.nextAvailableTime) freshState.nextAvailableTime = {};
                
                freshState.counts[`acc_${idx}`] = (freshState.counts[`acc_${idx}`] || 0) + 1;
                
                const randomLockMins = Math.floor(Math.random() * (30 - 25 + 1)) + 25; 
                freshState.nextAvailableTime[`acc_${idx}`] = Date.now() + (randomLockMins * 60000); 
                freshState.lastUsedAccountIndex = idx; 
                
                writeJSON(STATE_FILE, freshState);
                
                const left = selectedAcc.dailyLimit - freshState.counts[`acc_${idx}`];
                addLog("Success", idx, targetMsg.author.username, "Reply Bhej Diya! (Baaki: " + left + ", Lock: " + randomLockMins + " min)", aiResponse);
            } catch(e) {
                let errState = getSafeState();
                if(!errState.nextAvailableTime) errState.nextAvailableTime = {};
                errState.nextAvailableTime[`acc_${idx}`] = Date.now() + (15 * 60000); 
                errState.lastUsedAccountIndex = idx; 
                writeJSON(STATE_FILE, errState);
                addLog("Error", idx, targetMsg.author.username, "Send Failed: " + e.message + ". Locked for 15 mins.");
            }
            isProcessing = false;
            scheduleNextRun();
        }, delay);

    } catch (err) {
        let catchState = getSafeState();
        if(!catchState.nextAvailableTime) catchState.nextAvailableTime = {};
        
        if (err.statusCode === 401) {
            catchState.nextAvailableTime[`acc_${idx}`] = Date.now() + (60 * 60 * 1000); 
            addLog("Error", idx, "System Protection", "Token Invalid (401 Detected). Auto-isolated for 1 Hour.");
        } else {
            catchState.nextAvailableTime[`acc_${idx}`] = Date.now() + (5 * 60000); 
            addLog("Error", idx, "System Loop", "Cycle Error: " + err.message + ". Network delay.");
        }
        
        catchState.lastUsedAccountIndex = idx; 
        writeJSON(STATE_FILE, catchState);
        
        isProcessing = false;
        scheduleNextRun();
    }
}

// --- HTML UI GENERATOR ---
let HTML_TABS = `<div class="grid grid-cols-4 sm:grid-cols-6 gap-2 w-full">`;
HTML_TABS += `<button onclick="switchTab('dash')" id="tab-dash" class="tab-btn active px-2 py-3 text-xs font-bold rounded-lg border border-neutral-800 bg-neutral-900 transition-colors">Dashboard</button>`;
HTML_TABS += `<button onclick="switchTab('global')" id="tab-global" class="tab-btn px-2 py-3 text-xs font-bold rounded-lg border border-neutral-800 bg-neutral-900 transition-colors">Global Setup</button>`;

let HTML_ACCOUNTS = '';
for(let i=0; i<TOTAL_ACCOUNTS; i++) {
    HTML_TABS += `<button onclick="switchTab('acc${i}')" id="tab-acc${i}" class="tab-btn px-2 py-3 text-xs font-bold rounded-lg border border-neutral-800 bg-neutral-900 transition-colors relative break-words text-center leading-tight min-h-[44px]">Khata ${i+1} <span id="dot-${i}" class="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-500"></span></button>`;
    
    HTML_ACCOUNTS += `
    <div id="view-acc${i}" style="display:none;" class="space-y-5 pb-6">
        <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800 flex flex-col gap-3 shadow-md relative overflow-hidden">
            <div class="flex justify-between items-center w-full">
                <span id="acc-title-${i}" class="text-sm font-bold text-neutral-400 uppercase tracking-widest">Khata ${i+1} Progress</span>
                <span class="text-3xl font-black text-white"><span id="acc-count-${i}">0</span> <span class="text-lg font-bold text-neutral-600">/ <span id="acc-limit-disp-${i}">20</span></span></span>
            </div>
            <label class="flex items-center space-x-3 cursor-pointer mt-2 bg-neutral-950 p-3 rounded-xl border border-neutral-800">
                <input type="checkbox" id="a_active_${i}" class="w-5 h-5 accent-orange-500 rounded bg-neutral-900 border-neutral-700 cursor-pointer" checked>
                <span class="text-sm font-bold text-orange-400 uppercase tracking-widest">Enable This Account</span>
            </label>
        </div>
        <div class="grid grid-cols-2 gap-4">
            <div class="col-span-2">
                <label class="block text-xs font-bold text-orange-500 mb-2 uppercase tracking-widest">Discord Token</label>
                <input type="password" id="a_token_${i}" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3.5 text-white text-sm focus:border-orange-500 focus:outline-none" placeholder="Raw Token">
            </div>
            <div class="col-span-2">
                <label class="block text-xs font-bold text-orange-500 mb-2 uppercase tracking-widest">Daily Limit</label>
                <input type="number" id="a_limit_${i}" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3.5 text-white text-sm focus:border-orange-500 focus:outline-none" placeholder="20">
            </div>
        </div>
        <h3 id="acc-log-title-${i}" class="text-sm font-bold text-orange-500 mt-6 mb-3 uppercase tracking-widest border-b border-neutral-800 pb-2">Khata ${i+1} Logs</h3>
        <div id="logs-acc${i}" class="space-y-3"><p class="text-xs text-neutral-500">Is khate ke logs yaha dikhenge...</p></div>
    </div>`;
}
HTML_TABS += `</div>`;

const HTML_UI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Universal AI Station (Ultimate Dash)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background-color: #09090b; font-family: system-ui, -apple-system, sans-serif; }
        .tab-btn { color: #a3a3a3; }
        .tab-btn:hover { color: #f5f5f5; border-color: #404040; }
        .tab-btn.active { background-color: #ea580c; color: white; border-color: #ea580c; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #09090b; }
        ::-webkit-scrollbar-thumb { background: #262626; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #ea580c; }
    </style>
</head>
<body class="bg-neutral-950 text-neutral-50 min-h-screen pb-24">
    <div class="max-w-3xl mx-auto bg-neutral-950 min-h-screen border-x border-neutral-900 relative">
        <header class="bg-neutral-950 p-5 sticky top-0 z-30 border-b border-neutral-800 flex justify-between items-center shadow-md">
            <div>
                <h1 class="text-2xl font-black tracking-tight text-white">AI <span class="text-orange-600">Station</span></h1>
                <p class="text-xs text-neutral-500 mt-1 font-bold tracking-widest" id="live-clock">IST: --:--:--</p>
            </div>
            <button onclick="toggleBot()" id="main-toggle" class="px-6 py-2.5 rounded-full text-sm font-bold transition-all bg-orange-600 hover:bg-orange-500 text-white shadow-[0_0_15px_rgba(234,88,12,0.4)]">
                ▶ Start Bot
            </button>
        </header>

        <div class="bg-neutral-950 sticky top-[80px] z-20 border-b border-neutral-800 p-2 overflow-x-auto whitespace-nowrap">
            ${HTML_TABS}
        </div>

        <main class="p-5" id="main-content">
            <div id="view-dash" style="display:block;">
                <div class="grid grid-cols-2 gap-4 mb-6">
                    <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800 shadow-sm relative overflow-hidden">
                        <div class="absolute top-0 right-0 w-16 h-16 bg-orange-600 opacity-10 rounded-bl-full"></div>
                        <h3 class="text-xs font-bold text-neutral-400 mb-2 uppercase tracking-widest">Next Action</h3>
                        <div id="dash-timer" class="font-black text-lg text-white mb-3">Loading...</div>
                        <button onclick="forceRun()" class="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-xs font-bold text-orange-400 rounded-lg border border-neutral-700 transition-colors">⚡ Skip Wait & Run Now</button>
                    </div>
                    <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800 shadow-sm">
                        <h3 class="text-xs font-bold text-neutral-400 mb-2 uppercase tracking-widest">Active Progress</h3>
                        <div id="dash-progress" class="text-white font-black text-2xl">0 <span class="text-sm font-bold text-neutral-600">/ 0 Sent</span></div>
                    </div>
                </div>
                <h2 class="text-sm font-bold text-orange-500 mb-4 uppercase tracking-widest">Live Global Logs</h2>
                <div id="dash-logs" class="space-y-4"></div>
            </div>

            <div id="view-global" style="display:none;" class="space-y-5 pb-6">
                <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800 space-y-4">
                    <h3 class="text-sm font-bold text-orange-500 border-b border-neutral-800 pb-2 uppercase">1. Global Settings</h3>
                    <div>
                        <label class="block text-xs font-bold text-neutral-400 mb-2 uppercase tracking-widest">Discord Channel ID</label>
                        <input type="text" id="g_channel" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white text-sm focus:border-orange-500 focus:outline-none" placeholder="123456789">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-emerald-400 mb-2 uppercase tracking-widest">Bot Delay (Mins between replies)</label>
                        <input type="number" step="0.5" id="g_delay" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white text-sm focus:border-emerald-500 focus:outline-none" placeholder="e.g. 2">
                    </div>
                </div>
                
                <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800 space-y-4">
                    <h3 class="text-sm font-bold text-orange-500 border-b border-neutral-800 pb-2 uppercase">2. Universal API Setup</h3>
                    <div>
                        <label class="block text-xs font-bold text-orange-500 mb-2 uppercase tracking-widest">Provider Type</label>
                        <select id="g_provider" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white text-sm focus:border-orange-500 focus:outline-none" onchange="autoFillUrl()">
                            <option value="freemodel">FreeModel.dev (Recommended Proxy)</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="openai">OpenAI</option>
                            <option value="gemini">Google Gemini</option>
                            <option value="claude">Anthropic Claude</option>
                            <option value="custom">Custom API Gateway</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-orange-500 mb-1 mt-2 uppercase tracking-widest">API Keys</label>
                        <p class="text-[10px] text-neutral-500 mb-2">Paste keys here (one per line). FreeModel starts with fe_oa_...</p>
                        <textarea id="g_api" rows="3" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white text-sm focus:border-orange-500 focus:outline-none" placeholder="fe_oa_...\\nsk-or-...\\nAIzaSy..."></textarea>
                    </div>
                    <div class="mt-4 p-4 rounded-xl border border-dashed border-neutral-700 bg-neutral-950">
                        <label class="block text-xs font-bold text-orange-400 mb-2 uppercase tracking-widest">Endpoint URL & Models</label>
                        <input type="text" id="g_url" class="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2 text-white text-xs mb-3 focus:border-neutral-500 focus:outline-none" placeholder="Base URL">
                        <div class="flex flex-col gap-2">
                            <button onclick="triggerAutoFetch()" id="btn-fetch" class="w-full py-2 bg-neutral-800 hover:bg-neutral-700 text-xs font-bold text-emerald-400 rounded-lg border border-neutral-700 transition-colors">⚡ Click to Auto-Fetch Models</button>
                            <div id="model-container">
                                <input type="text" id="g_model" class="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2 text-white text-xs focus:border-neutral-500 focus:outline-none" placeholder="Manual model (e.g. gpt-5.5)">
                            </div>
                        </div>
                    </div>
                </div>

                <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800 space-y-4">
                    <h3 class="text-sm font-bold text-orange-500 border-b border-neutral-800 pb-2 uppercase">3. Knowledge Base (Rules)</h3>
                    <p class="text-[10px] text-neutral-500 mb-2 leading-relaxed">Paste your Instant Funding rules here. The bot will automatically learn them.</p>
                    <textarea id="g_rules" rows="8" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white text-xs focus:border-orange-500 focus:outline-none"></textarea>
                </div>

                <div class="bg-neutral-900 p-5 rounded-2xl border border-neutral-800">
                    <label class="block text-xs font-bold text-red-500 mb-1 uppercase tracking-widest">Ignore Bot IDs</label>
                    <textarea id="g_ignore" rows="3" class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white text-sm focus:border-red-500 focus:outline-none"></textarea>
                </div>
            </div>

            ${HTML_ACCOUNTS}
        </main>
        
        <div class="fixed bottom-0 w-full max-w-3xl bg-neutral-950 p-4 border-t border-neutral-800 z-30 flex gap-2 shadow-[0_-5px_15px_rgba(0,0,0,0.5)]">
            <button onclick="exportData()" class="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-bold py-3.5 px-2 rounded-xl shadow-lg transition-all text-[10px] sm:text-xs uppercase tracking-widest flex-1 text-center border border-neutral-700">⬇️ BACKUP</button>
            <button onclick="document.getElementById('import-file').click()" class="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-bold py-3.5 px-2 rounded-xl shadow-lg transition-all text-[10px] sm:text-xs uppercase tracking-widest flex-1 text-center border border-neutral-700">⬆️ RESTORE</button>
            <input type="file" id="import-file" style="display:none" accept=".json" onchange="importData(event)">
            <button onclick="saveData()" id="save-btn" class="bg-orange-600 hover:bg-orange-500 text-white font-black py-3.5 px-4 rounded-xl shadow-lg transition-all flex-[2] text-center tracking-wide uppercase text-sm">Save Dashboard</button>
        </div>
    </div>

    <script>
        const TOTAL_ACCOUNTS = ${TOTAL_ACCOUNTS};
        let config = { isActive: false, channelId: "", providerType: "freemodel", apiUrl:"https://api.freemodel.dev/v1/chat/completions", apiModel:"gpt-5.5", apiKeys: "", ignoreIds: "", replyDelayMin: 3, accounts: [] };
        let state = { counts: {}, nextAvailableTime:{}, nextRunTime: null, nextAccountIndex: null, accountNames: {} };
        let logs = [];
        let rulesText = "";
        
        let ALL_TABS = ['dash', 'global'];
        for(let i=0; i<TOTAL_ACCOUNTS; i++) ALL_TABS.push('acc'+i);

        function autoFillUrl() {
            const p = document.getElementById('g_provider').value;
            const url = document.getElementById('g_url');
            if(p === 'freemodel') url.value = "https://api.freemodel.dev/v1/chat/completions";
            else if(p === 'openrouter') url.value = "https://openrouter.ai/api/v1/chat/completions";
            else if(p === 'openai') url.value = "https://api.openai.com/v1/chat/completions";
            else if(p === 'gemini') url.value = "https://generativelanguage.googleapis.com";
            else if(p === 'claude') url.value = "https://api.anthropic.com/v1/messages";
            else if(p === 'custom') url.value = "https://api.tokenlb.net/v1/chat/completions";
            
            if(p === 'freemodel') {
                document.getElementById('model-container').innerHTML = '<input type="text" id="g_model" class="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2 text-white text-xs focus:outline-none" value="gpt-5.5">';
            }
        }

        async function triggerAutoFetch() {
            const providerType = document.getElementById('g_provider').value;
            const apiKeys = document.getElementById('g_api').value;
            const apiUrl = document.getElementById('g_url').value;
            const btn = document.getElementById('btn-fetch');
            
            if(!apiKeys.trim()) { alert("Please enter API Keys first!"); return; }

            btn.innerText = "Fetching models...";
            btn.disabled = true;

            try {
                const res = await fetch('/api/fetch-models', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ providerType: providerType, apiKeys: apiKeys, apiUrl: apiUrl })
                });
                const data = await res.json();
                if(data.error) throw new Error(data.error);
                
                let container = document.getElementById('model-container');
                let html = '<select id="g_model" class="w-full bg-neutral-900 border border-emerald-500 rounded-lg p-2 text-white text-xs focus:outline-none">';
                data.models.forEach(m => { html += '<option value="' + m + '">' + m + '</option>'; });
                html += '</select>';
                container.innerHTML = html;
                alert("Models loaded successfully! Select from dropdown.");
            } catch(e) {
                alert("Fail to fetch: " + e.message);
            } finally {
                btn.innerText = "⚡ Click to Auto-Fetch Models";
                btn.disabled = false;
            }
        }

        function exportData() {
            saveCurrentFormToMemory();
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({config: config, rulesText: rulesText}, null, 2));
            const downloadAnchorElem = document.createElement('a');
            downloadAnchorElem.setAttribute("href", dataStr);
            downloadAnchorElem.setAttribute("download", "bot_backup_ultimate.json");
            document.body.appendChild(downloadAnchorElem);
            downloadAnchorElem.click(); downloadAnchorElem.remove();
        }

        function importData(event) {
            const file = event.target.files[0];
            if(!file) return;
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const imported = JSON.parse(e.target.result);
                    document.getElementById('save-btn').innerHTML = "Restoring...";
                    await fetch('/api/config', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ config: imported.config, rules: imported.rulesText }) });
                    alert("✅ Backup Restore Success!"); location.reload();
                } catch(err) { alert("❌ Invalid File Format!"); }
            };
            reader.readAsText(file);
        }

        function populateInputs() {
            document.getElementById('g_channel').value = config.channelId || '';
            document.getElementById('g_provider').value = config.providerType || 'freemodel';
            document.getElementById('g_url').value = config.apiUrl || 'https://api.freemodel.dev/v1/chat/completions';
            document.getElementById('g_api').value = config.apiKeys || '';
            document.getElementById('g_ignore').value = config.ignoreIds || '';
            document.getElementById('g_delay').value = config.replyDelayMin || 3;
            document.getElementById('g_rules').value = rulesText || '';
            
            let container = document.getElementById('model-container');
            let mVal = config.apiModel || 'gpt-5.5';
            container.innerHTML = '<input type="text" id="g_model" class="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2 text-white text-xs focus:outline-none" value="' + mVal + '">';

            for(let i=0; i<TOTAL_ACCOUNTS; i++) {
                if(config.accounts && config.accounts[i]) {
                    if(document.getElementById('a_token_'+i)) document.getElementById('a_token_'+i).value = config.accounts[i].token || '';
                    if(document.getElementById('a_limit_'+i)) document.getElementById('a_limit_'+i).value = config.accounts[i].dailyLimit || 20;
                    if(document.getElementById('a_active_'+i)) document.getElementById('a_active_'+i).checked = config.accounts[i].isActive !== false;
                }
            }
        }

        function buildLogHTML(l) {
            let borderClass = '', dot = '';
            if(l.status === 'Success') { borderClass = 'border-l-4 border-l-green-500'; dot = '<span class="text-green-500">●</span>'; }
            else if(l.status === 'Warning') { borderClass = 'border-l-4 border-l-yellow-500'; dot = '<span class="text-yellow-500">●</span>'; }
            else if(l.status === 'Error') { borderClass = 'border-l-4 border-l-red-500'; dot = '<span class="text-red-500">●</span>'; }
            else { borderClass = 'border-l-4 border-l-orange-500'; dot = '<span class="text-orange-500">●</span>'; }

            let baseName = (state.accountNames && state.accountNames[l.accountIndex]) ? state.accountNames[l.accountIndex] : 'KHATA ' + (parseInt(l.accountIndex)+1);
            const accTitle = (l.accountIndex === "System") ? "SYSTEM" : baseName.toUpperCase();
            
            let html = '<div class="p-4 rounded-xl border border-neutral-800 bg-neutral-900 ' + borderClass + ' shadow-sm">';
            html += '<div class="flex justify-between items-center mb-2 pb-2 border-b border-neutral-800">';
            html += '<span class="font-bold text-xs uppercase tracking-widest text-neutral-300">' + dot + ' ' + accTitle + '</span>';
            html += '<span class="text-[10px] font-bold text-neutral-500 tracking-wider">' + l.time + '</span></div>';
            html += '<p class="text-sm font-medium text-neutral-200"><span class="text-neutral-500">Action:</span> ' + l.message + '</p>';
            if(l.targetUser && l.targetUser !== "None" && l.targetUser !== "Unknown" && l.targetUser !== "General Chat") {
                html += '<p class="text-sm font-medium mt-1 text-neutral-200"><span class="text-neutral-500">Replied to:</span> <span class="font-bold text-orange-400">@' + l.targetUser + '</span></p>';
            }
            if(l.aiReply) { html += '<div class="mt-3 p-3 bg-neutral-950 rounded-lg text-xs italic text-neutral-300 border border-neutral-800 leading-relaxed font-medium">"' + l.aiReply + '"</div>'; }
            html += '</div>';
            return html;
        }

        function updateDashView() {
            const btn = document.getElementById('main-toggle');
            if(config.isActive) {
                btn.innerHTML = "⏸ Stop Bot"; btn.className = "px-6 py-2.5 rounded-full text-sm font-bold transition-all bg-red-600 hover:bg-red-500 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)]";
            } else {
                btn.innerHTML = "▶ Start Bot"; btn.className = "px-6 py-2.5 rounded-full text-sm font-bold transition-all bg-orange-600 hover:bg-orange-500 text-white shadow-[0_0_15px_rgba(234,88,12,0.4)]";
            }

            let timerHtml = '';
            if(!config.isActive) {
                timerHtml = '<span class="text-red-500 text-sm">Offline</span>';
            } else if(state.nextRunTime) {
                const diff = Math.round((state.nextRunTime - Date.now())/60000);
                let nextNameText = "";
                if(state.nextAccountIndex !== null && state.nextAccountIndex !== undefined) {
                    let dispName = (state.accountNames && state.accountNames[state.nextAccountIndex]) ? state.accountNames[state.nextAccountIndex] : 'Khata ' + (state.nextAccountIndex + 1);
                    nextNameText = '<br><span class="text-xs text-neutral-500">Next: ' + dispName + '</span>';
                }
                if(diff <= 0) timerHtml = '<span class="text-orange-400 text-sm animate-pulse">Processing...</span>' + nextNameText;
                else timerHtml = '<span class="text-emerald-400 text-sm">Reading in ' + diff + ' Mins...</span>' + nextNameText;
            } else {
                timerHtml = '<span class="text-neutral-400 text-sm">All Limits Reached ✓</span>';
            }
            document.getElementById('dash-timer').innerHTML = timerHtml;

            let totalSent = 0; let totalLimit = 0;
            for(let i=0; i<TOTAL_ACCOUNTS; i++) {
                let limit = 20; let isActive = true;
                let dispName = (state.accountNames && state.accountNames[i]) ? state.accountNames[i] : 'Khata ' + (i+1);
                
                if(config.accounts && config.accounts[i]) {
                    isActive = config.accounts[i].isActive !== false;
                    if(isActive && config.accounts[i].token) {
                        totalSent += (state.counts['acc_'+i]||0);
                        limit = config.accounts[i].dailyLimit || 20;
                        totalLimit += limit;
                    }
                    if(document.getElementById('acc-limit-disp-'+i)) document.getElementById('acc-limit-disp-'+i).innerText = limit;
                }
                if(document.getElementById('acc-count-'+i)) document.getElementById('acc-count-'+i).innerText = state.counts['acc_'+i]||0;
                
                const tabBtn = document.getElementById('tab-acc'+i);
                if(tabBtn) {
                    const dotClass = isActive ? "bg-emerald-500" : "bg-red-600";
                    tabBtn.innerHTML = dispName + ' <span id="dot-' + i + '" class="absolute top-1 right-1 w-2 h-2 rounded-full ' + dotClass + '"></span>';
                }

                const accTitleEl = document.getElementById('acc-title-'+i);
                if(accTitleEl) accTitleEl.innerText = dispName + ' Progress';
                const accLogTitleEl = document.getElementById('acc-log-title-'+i);
                if(accLogTitleEl) accLogTitleEl.innerText = dispName + ' Logs';
            }
            document.getElementById('dash-progress').innerHTML = totalSent + ' <span class="text-sm font-bold text-neutral-600">/ ' + totalLimit + ' Sent</span>';

            let globalLogsHtml = ''; let accLogsHtml = Array(TOTAL_ACCOUNTS).fill('');
            logs.forEach(l => {
                const html = buildLogHTML(l);
                globalLogsHtml += html; 
                if(l.accountIndex !== "System" && accLogsHtml[parseInt(l.accountIndex)] !== undefined) {
                    accLogsHtml[parseInt(l.accountIndex)] += html; 
                }
            });

            if(globalLogsHtml === '') globalLogsHtml = '<p class="text-sm text-neutral-500 p-4 font-medium">Koi logs nahi...</p>';
            document.getElementById('dash-logs').innerHTML = globalLogsHtml;
            for(let i=0; i<TOTAL_ACCOUNTS; i++) {
                let el = document.getElementById('logs-acc'+i);
                if(el) el.innerHTML = accLogsHtml[i] === '' ? '<p class="text-sm text-neutral-500 font-medium">Koi activity nahi hui abhi tak.</p>' : accLogsHtml[i];
            }
        }

        function switchTab(tabId) {
            saveCurrentFormToMemory(); 
            ALL_TABS.forEach(id => {
                const view = document.getElementById('view-' + id);
                const tab = document.getElementById('tab-' + id);
                if(view) view.style.display = 'none';
                if(tab) tab.classList.remove('active');
            });
            const activeView = document.getElementById('view-' + tabId);
            const activeTab = document.getElementById('tab-' + tabId);
            if(activeView) activeView.style.display = 'block';
            if(activeTab) {
                activeTab.classList.add('active');
                activeTab.scrollIntoView({behavior: "smooth", inline: "center"});
            }
        }

        function saveCurrentFormToMemory() {
            config.channelId = document.getElementById('g_channel').value;
            config.providerType = document.getElementById('g_provider').value;
            config.apiUrl = document.getElementById('g_url').value;
            config.apiModel = document.getElementById('g_model') ? document.getElementById('g_model').value : "";
            config.apiKeys = document.getElementById('g_api').value;
            config.ignoreIds = document.getElementById('g_ignore').value;
            config.replyDelayMin = parseFloat(document.getElementById('g_delay').value) || 3;
            rulesText = document.getElementById('g_rules').value;

            config.accounts = [];
            for(let i=0; i<TOTAL_ACCOUNTS; i++) {
                let tokenVal = "", limitVal = 20, isActiveVal = true;
                if(document.getElementById('a_token_'+i)) tokenVal = document.getElementById('a_token_'+i).value;
                if(document.getElementById('a_limit_'+i)) limitVal = parseInt(document.getElementById('a_limit_'+i).value) || 20;
                if(document.getElementById('a_active_'+i)) isActiveVal = document.getElementById('a_active_'+i).checked;
                config.accounts.push({token: tokenVal, dailyLimit: limitVal, isActive: isActiveVal});
            }
        }

        async function saveData() {
            saveCurrentFormToMemory();
            const btn = document.getElementById('save-btn');
            btn.innerHTML = "Saving...";
            await fetch('/api/config', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ config: config, rules: rulesText }) });
            btn.innerHTML = "Saved ✓"; 
            btn.classList.replace('bg-orange-600', 'bg-green-600');
            setTimeout(() => { btn.innerHTML = "Save Dashboard"; btn.classList.replace('bg-green-600', 'bg-orange-600'); }, 2000);
            fetchDashData();
        }

        async function toggleBot() {
            config.isActive = !config.isActive;
            await fetch('/api/toggle', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({isActive: config.isActive}) });
            fetchDashData();
        }

        async function forceRun() {
            if(!config.isActive) { alert("Pehle bot start karein!"); return; }
            await fetch('/api/force-run', { method: 'POST' });
            fetchDashData();
        }

        async function initialLoad() {
            try {
                const resConfig = await fetch('/api/get-system');
                const data = await resConfig.json();
                config = data.config;
                rulesText = data.rules;
                while(config.accounts.length < TOTAL_ACCOUNTS) config.accounts.push({token:"", dailyLimit:20, isActive:true});
                populateInputs(); await fetchDashData(); 
            } catch (e) { console.log('Error', e); }
        }

        async function fetchDashData() {
            try {
                const [s, l] = await Promise.all([fetch('/api/state'), fetch('/api/logs')]);
                state = await s.json(); logs = await l.json();
                updateDashView(); 
            } catch (e) { console.log('Error', e); }
        }

        setInterval(() => {
            const d = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
            let hours = d.getUTCHours();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12; 
            document.getElementById('live-clock').innerText = "IST: " + hours.toString().padStart(2, '0') + ":" + d.getUTCMinutes().toString().padStart(2, '0') + ":" + d.getUTCSeconds().toString().padStart(2, '0') + " " + ampm;
        }, 1000);

        setInterval(fetchDashData, 5000); initialLoad();
    </script>
</body>
</html>
`;

// --- EXPRESS SERVER LOGIC ---
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML_UI); } 
    else if (req.method === 'GET' && req.url === '/api/get-system') { 
        const config = getSafeConfig();
        let rulesText = "";
        if (fs.existsSync(RULES_FILE)) rulesText = fs.readFileSync(RULES_FILE, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' }); 
        res.end(JSON.stringify({ config: config, rules: rulesText })); 
    }
    else if (req.method === 'GET' && req.url === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getSafeState())); }
    else if (req.method === 'GET' && req.url === '/api/logs') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(readJSON(LOGS_FILE, []))); }
    else if (req.method === 'POST' && req.url === '/api/force-run') { scheduleNextRun(true); res.writeHead(200); res.end(JSON.stringify({ success: true })); }
    
    // Save Logic
    else if (req.method === 'POST' && req.url === '/api/config') {
        collectRequestData(req, (data) => {
            if(data.config) writeJSON(CONFIG_FILE, data.config);
            if(data.rules !== undefined) fs.writeFileSync(RULES_FILE, data.rules);
            fetchAccountProfiles(); 
            res.writeHead(200); res.end(JSON.stringify({ success: true })); 
        });
    }
    
    // Auto-Fetch Models Logic
    else if (req.method === 'POST' && req.url === '/api/fetch-models') {
        collectRequestData(req, async (data) => {
            const provider = data.providerType;
            const keysRaw = data.apiKeys || "";
            const keys = keysRaw.replace(/\r/g, '').replace(/\n/g, ',').split(',').map(k => k.trim()).filter(k => k !== "");
            let customUrl = data.apiUrl ? data.apiUrl.trim() : "";

            if (keys.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Please enter at least one API key first!" }));
            }
            const key = keys[0];

            try {
                let models = [];
                if (provider === 'freemodel') {
                    const r = await fetch("https://api.freemodel.dev/v1/models", { headers: { 'Authorization': "Bearer " + key } });
                    if (!r.ok) throw new Error("FreeModel HTTP " + r.status);
                    const d = await r.json();
                    if (d.data && Array.isArray(d.data)) models = d.data.map(m => m.id);
                    else models = ["gpt-5.5", "gpt-4o", "gpt-3.5-turbo"]; 
                }
                else if (provider === 'openrouter') {
                    const r = await fetch("https://openrouter.ai/api/v1/models");
                    if (!r.ok) throw new Error("OpenRouter HTTP " + r.status);
                    const d = await r.json();
                    if (d.data && Array.isArray(d.data)) models = d.data.map(m => m.id);
                } 
                else if (provider === 'gemini') {
                    const target = "https://generativelanguage.googleapis.com/v1beta/models?key=" + key;
                    const r = await fetch(target);
                    if (!r.ok) throw new Error("Gemini Models HTTP " + r.status);
                    const d = await r.json();
                    if (d.models && Array.isArray(d.models)) models = d.models.map(m => m.name.replace('models/', ''));
                } 
                else if (provider === 'claude') {
                    models = ["claude-3-haiku-20240307", "claude-3-5-sonnet-20240620", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"];
                } 
                else {
                    let target = customUrl ? customUrl.replace('/chat/completions', '/models') : "https://api.openai.com/v1/models";
                    if (!target.endsWith('/models') && !target.includes('/models?')) {
                        target = target.substring(0, target.lastIndexOf('/')) + '/models';
                    }
                    const r = await fetch(target, { headers: { 'Authorization': "Bearer " + key } });
                    if (!r.ok) throw new Error("Endpoint HTTP " + r.status);
                    const d = await r.json();
                    if (d.data && Array.isArray(d.data)) models = d.data.map(m => m.id);
                }

                models = [...new Set(models)].sort();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ models: models }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Fetch Failed: " + err.message }));
            }
        });
    }

    else if (req.method === 'POST' && req.url === '/api/toggle') {
        collectRequestData(req, (data) => {
            let conf = getSafeConfig(); conf.isActive = data.isActive; writeJSON(CONFIG_FILE, conf);
            if(conf.isActive) { addLog("Info", "System", "None", "Bot Station manually START!"); if(botTimer) clearTimeout(botTimer); scheduleNextRun(); } 
            else { addLog("Info", "System", "None", "Bot Station manually STOP!"); if(botTimer) clearTimeout(botTimer); let s = getSafeState(); s.nextRunTime = null; writeJSON(STATE_FILE, s); }
            res.writeHead(200); res.end(JSON.stringify({ success: true }));
        });
    }
    else { res.writeHead(404); res.end("Not Found"); }
});

server.listen(PORT, () => { console.log("Station running on port " + PORT); fetchAccountProfiles(); });
