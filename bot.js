import { GoogleGenAI } from '@google/genai';
import { WOLF } from 'wolf.js';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.trim().match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch(_) {}

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const BOT_EMAIL  = 'scodoublet@yahoo.com';
const BOT_PASS   = '12345';
const DATA_FILE  = path.join(__dirname, 'players.json');

const _geminiKey     = process.env.AI_INTEGRATIONS_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const _geminiBaseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
const _isReplit      = !!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || (_isReplit ? 'gemini-2.5-flash' : 'gemini-1.5-flash');
console.log(`[AI] نموذج Gemini: ${GEMINI_MODEL} | Replit=${_isReplit}`);
const ai = new GoogleGenAI({
  apiKey: _geminiKey,
  ..._geminiBaseUrl ? { httpOptions: { apiVersion: '', baseUrl: _geminiBaseUrl } } : {},
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let _lastCall = 0;
let _activeCall = false;
const CALL_GAP_MS = _isReplit ? 1200 : 4000;

function buildConfig(maxTokens, temp) {
  const base = { maxOutputTokens: maxTokens, temperature: temp };
  if (_isReplit) base.thinkingConfig = { thinkingBudget: 0 };
  return base;
}

async function gemini(prompt, maxTokens = 4096, temp = 0.7) {
  while (_activeCall) await sleep(200);
  const gap = CALL_GAP_MS - (Date.now() - _lastCall);
  if (gap > 0) await sleep(gap);
  _activeCall = true;
  _lastCall = Date.now();
  try {
    const r = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: buildConfig(maxTokens, temp),
    });
    return (r.text || '').trim();
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('RATELIMIT') || msg.includes('429')) {
      console.warn('[RATE LIMIT] انتظار 20 ثانية...');
      await sleep(20000);
      const r2 = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: buildConfig(maxTokens, temp),
      });
      return (r2.text || '').trim();
    }
    console.error('[AI ERR]', msg.slice(0, 120));
    throw e;
  } finally {
    _activeCall = false;
  }
}

async function geminiJSON(prompt, maxTokens = 512, temp = 0) {
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await gemini(prompt, maxTokens, temp);
      let c = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'')
                 .replace(/^[^{[]*/,'').replace(/[^}\]]*$/,'').trim();
      c = c.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match) =>
        match.replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\t/g,'\\t')
      );
      return JSON.parse(c);
    } catch(e) {
      if (i === 2) throw e;
      await sleep(1500);
    }
  }
}

function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e) {}
  return { players:{} };
}
function saveDB(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2),'utf8'); } catch(e) {}
}
let db = loadDB();

function getPlayer(uid, name, cid) {
  const k = String(uid);
  if (!db.players[k]) { db.players[k] = { id:uid, name:name||k, pts:0, channels:[] }; }
  else {
    if (name && db.players[k].name !== name) db.players[k].name = name;
    if (!db.players[k].channels) db.players[k].channels = [];
  }
  if (cid && !db.players[k].channels.includes(String(cid))) {
    db.players[k].channels.push(String(cid));
  }
  saveDB(db);
  return db.players[k];
}
function addPts(uid, n, cid) {
  const k = String(uid);
  if (!db.players[k]) db.players[k] = { id:uid, name:k, pts:0, channels:[] };
  if (!db.players[k].channels) db.players[k].channels = [];
  db.players[k].pts = (db.players[k].pts||0) + Math.max(0,n);
  if (cid && !db.players[k].channels.includes(String(cid))) {
    db.players[k].channels.push(String(cid));
  }
  saveDB(db);
}
function realPlayers() {
  return Object.values(db.players).filter(p => (p.pts||0) > 0).sort((a,b) => b.pts - a.pts);
}
function realPlayersInChannel(cid) {
  const c = String(cid);
  return Object.values(db.players)
    .filter(p => (p.pts||0) > 0 && Array.isArray(p.channels) && p.channels.includes(c))
    .sort((a,b) => b.pts - a.pts);
}

const games    = {};
const autoSt   = {};
const pregenQ  = {};
const busy     = {};
const lastAns  = {};

const VULGAR_RE = /زب|كس|طيز|شرم|عاهر|ق[حض]ب[هة]|منيو[كك]|متناك|ينيك|بتناك|نيك|شراميط|عرص|لوطي|خول|فاجر[هة]?|داعر[هة]?|فاحش[هة]?|porn|sex(?:ual|y)?|fuck|shit|bitch|cock|pussy|ass(?:hole)?|dick|nude|naked|xxx/i;
function isVulgar(text) { return VULGAR_RE.test(text); }

function fastDetect(text) {
  const t = text.trim();
  const tl = t.toLowerCase().replace(/\s+/g,' ');

  if (/^[!！](لغه|لغة)\s*(مساعده|مساعدة)$/.test(tl)) return {cmd:'HELP',userLang:'Arabic'};
  if (/^[!！](لغه|لغة)\s*(مجموع|نقاطي)/.test(tl)) return {cmd:'MY_SCORE',userLang:'Arabic'};
  if (/^[!！](لغه|لغة)\s*ترتيب\s*قنا/.test(tl)) return {cmd:'RANK_CHANNEL',userLang:'Arabic'};
  if (/^[!！](لغه|لغة)\s*ترتيب\s*(ولف|wolf)/.test(tl)) return {cmd:'RANK_GLOBAL',userLang:'Arabic'};
  if (/^[!！](لغه|لغة)\s*(التالي|تالي)/.test(tl)) return {cmd:'NEXT',userLang:'Arabic'};

  if (/^[!！]معرفات\s*تلقائي/.test(tl)) return {cmd:'AUTO_GAME_GUESS',userLang:'Arabic'};
  if (/^[!！]معاني\s*تلقائي/.test(tl))  return {cmd:'AUTO_GAME_WORD',userLang:'Arabic'};

  {
    const LM = {
      'عربي':'Arabic','عربية':'Arabic',
      'انجليزي':'English','انجليزية':'English','انكليزي':'English','إنجليزي':'English',
      'فرنسي':'French','فرنسية':'French','تركي':'Turkish','تركية':'Turkish',
      'الماني':'German','المانية':'German','ألماني':'German',
      'اسباني':'Spanish','اسبانية':'Spanish','إسباني':'Spanish',
      'ايطالي':'Italian','ايطالية':'Italian','إيطالي':'Italian',
      'فارسي':'Persian','فارسية':'Persian','اردو':'Urdu','أردو':'Urdu',
      'هندي':'Hindi','صيني':'Chinese','روسي':'Russian',
      'ياباني':'Japanese','كوري':'Korean','برتغالي':'Portuguese','هولندي':'Dutch',
    };
    const mAW = t.match(/^[!！]كلم[هة]\s+(\S+)\s+(\S+)\s*تلقائي/i);
    if (mAW) return {cmd:'AUTO_GAME_TR_WORD',userLang:'Arabic',fromLang:LM[mAW[1]]||mAW[1],toLang:LM[mAW[2]]||mAW[2]};
    const mAS = t.match(/^[!！]جمل[هة]\s+(\S+)\s+(\S+)\s*تلقائي/i);
    if (mAS) return {cmd:'AUTO_GAME_TR_SENT',userLang:'Arabic',fromLang:LM[mAS[1]]||mAS[1],toLang:LM[mAS[2]]||mAS[2]};
    const mAT = t.match(/^[!！]نص\s+(\S+)\s+(\S+)\s*تلقائي/i);
    if (mAT) return {cmd:'AUTO_GAME_TR_TEXT',userLang:'Arabic',fromLang:LM[mAT[1]]||mAT[1],toLang:LM[mAT[2]]||mAT[2]};
  }

  if (/^[!！]كلم[هة]\s*تلقائي/.test(tl))      return {cmd:'AUTO_GAME_TR_WORD',userLang:'Arabic'};
  if (/^[!！]جمل[هة]\s*تلقائي/.test(tl))      return {cmd:'AUTO_GAME_TR_SENT',userLang:'Arabic'};
  if (/^[!！]نص\s*تلقائي/.test(tl))            return {cmd:'AUTO_GAME_TR_TEXT',userLang:'Arabic'};
  if (/^[!！](اعرب|إعراب)\s*تلقائي/.test(tl)) return {cmd:'AUTO_GAME_GRAMMAR',userLang:'Arabic'};

  if (/^[!！]معرفات\s*بدء$/.test(tl)) return {cmd:'GAME_GUESS',  userLang:'Arabic'};
  if (/^[!！]معاني\s*بدء/.test(tl))   return {cmd:'GAME_WORD',   userLang:'Arabic'};
  if (/^[!！](اعرب|إعراب)\s*بدء$/.test(tl)) return {cmd:'GAME_GRAMMAR',userLang:'Arabic'};

  {
    const LANG_MAP = {
      'عربي':'Arabic','عربية':'Arabic',
      'انجليزي':'English','انجليزية':'English','انكليزي':'English','إنجليزي':'English',
      'فرنسي':'French','فرنسية':'French','تركي':'Turkish','تركية':'Turkish',
      'الماني':'German','المانية':'German','ألماني':'German',
      'اسباني':'Spanish','اسبانية':'Spanish','إسباني':'Spanish',
      'ايطالي':'Italian','ايطالية':'Italian','إيطالي':'Italian',
      'فارسي':'Persian','فارسية':'Persian','اردو':'Urdu','أردو':'Urdu',
      'هندي':'Hindi','صيني':'Chinese','روسي':'Russian',
      'ياباني':'Japanese','كوري':'Korean','برتغالي':'Portuguese','هولندي':'Dutch',
    };
    const mWord = t.match(/^[!！]كلم[هة]\s+(\S+)\s+(\S+)\s*بدء/i);
    if (mWord) {
      const fl = LANG_MAP[mWord[1]]||mWord[1], tl2 = LANG_MAP[mWord[2]]||mWord[2];
      return {cmd:'GAME_TR_WORD',userLang:'Arabic',fromLang:fl,toLang:tl2,queryText:''};
    }
    const mSent = t.match(/^[!！]جمل[هة]\s+(\S+)\s+(\S+)\s*بدء/i);
    if (mSent) {
      const fl = LANG_MAP[mSent[1]]||mSent[1], tl2 = LANG_MAP[mSent[2]]||mSent[2];
      return {cmd:'GAME_TR_SENT',userLang:'Arabic',fromLang:fl,toLang:tl2,queryText:''};
    }
    const mText = t.match(/^[!！]نص\s+(\S+)\s+(\S+)\s*بدء/i);
    if (mText) {
      const fl = LANG_MAP[mText[1]]||mText[1], tl2 = LANG_MAP[mText[2]]||mText[2];
      return {cmd:'GAME_TR_TEXT',userLang:'Arabic',fromLang:fl,toLang:tl2,queryText:''};
    }
  }

  if (/^[!！]معن[ىي]\s+\S/.test(tl)) {
    const m = t.match(/^[!！]\S+\s+(.+)/);
    return {cmd:'MEANING', userLang:'Arabic', queryText: m?m[1].trim():''};
  }

  if (/^[!！]ترجم[هة]?\s+\S/.test(tl)) {
    const parts = t.replace(/^[!！]\S+\s+/, '').trim().split(/\s+/);
    const langWord = parts[0] || '';
    const queryText = parts.slice(1).join(' ');
    const langMap = {
      'انجليزي':'English','انجليزية':'English','انكليزي':'English',
      'عربي':'Arabic','عربية':'Arabic','فرنسي':'French','فرنسية':'French',
      'تركي':'Turkish','تركية':'Turkish','الماني':'German','المانية':'German',
      'اسباني':'Spanish','اسبانية':'Spanish','ايطالي':'Italian','ايطالية':'Italian',
      'فارسي':'Persian','فارسية':'Persian','اردو':'Urdu','هندي':'Hindi',
      'صيني':'Chinese','روسي':'Russian','ياباني':'Japanese','كوري':'Korean',
      'برتغالي':'Portuguese','هولندي':'Dutch',
    };
    const toLang = langMap[langWord] || langWord || 'English';
    return {cmd:'TRANSLATE', userLang:'Arabic', fromLang:'Arabic', toLang, queryText};
  }

  return null;
}

const OTHER_BOT_PREFIXES = [
  '!نان','!مد','!س ','!ص ','!ط ','!عدنان','!صور','!صوره',
  '!welcome','!ترحيب','!auto','!أوتو','!موسيقى','!music',
  '!ميوزك','!وولف','!bot','!بوت','!quiz','!كويز',
  '!mod','!admin','!ban','!kick','!mute',
];
function isOtherBotCmd(text) {
  const tl = text.toLowerCase();
  return OTHER_BOT_PREFIXES.some(p => tl.startsWith(p.toLowerCase()));
}

const unknownCache = new Map();
const UNKNOWN_TTL  = 5 * 60 * 1000;
function getCacheKey(text) { return text.trim().toLowerCase().slice(0, 12); }

async function detectIntent(text) {
  if (isOtherBotCmd(text)) return {cmd:'UNKNOWN',userLang:'Arabic'};
  const ck = getCacheKey(text);
  const cached = unknownCache.get(ck);
  if (cached && Date.now() - cached < UNKNOWN_TTL) return {cmd:'UNKNOWN',userLang:'Arabic'};
  try {
    const r = await geminiJSON(
`Command parser for a language-learning bot. Detect the command from this message in ANY language.

Commands (understand by MEANING, not exact words):
MEANING        - wants definition of a word/phrase (e.g. !معنى كلمة)
TRANSLATE      - wants to translate text to another language (e.g. !ترجمه ...)
GAME_TR_WORD   - start word-translation game [exact pattern: !كلمه/!كلمة {from} {to} بدء]
GAME_TR_SENT   - start sentence-translation game [exact pattern: !جمله/!جملة {from} {to} بدء]
GAME_TR_TEXT   - start text-translation game [exact pattern: !نص {from} {to} بدء]
AUTO_GAME_TR_WORD - toggle auto word-translation [exact pattern: !كلمه/!كلمة تلقائي]
AUTO_GAME_TR_SENT - toggle auto sentence-translation [exact pattern: !جمله/!جملة تلقائي]
AUTO_GAME_TR_TEXT - toggle auto text-translation [exact pattern: !نص تلقائي]
MY_SCORE       - show my points [exact: !لغه/!لغة مجموع or نقاطي]
RANK_CHANNEL   - show top players in channel [exact: !لغه/!لغة ترتيب قناه/قناة]
RANK_GLOBAL    - show global ranking [exact: !لغه/!لغة ترتيب ولف/wolf]
UNKNOWN        - everything else

IMPORTANT: Return UNKNOWN for anything that looks like another bot's command or game message.
IMPORTANT: HELP, GAME_GUESS, GAME_WORD, GAME_GRAMMAR, AUTO_GAME_GUESS, AUTO_GAME_WORD, AUTO_GAME_GRAMMAR, NEXT are handled separately — always return UNKNOWN for them.

Message: "${text.replace(/"/g,"'").replace(/\n/g,' ').slice(0,200)}"

userLang = the language the user wrote in (English/Arabic/French/Turkish/etc.)
For MEANING: put word in queryText. For TRANSLATE: toLang + queryText.
For TR games: extract fromLang/toLang if mentioned.

JSON only: {"cmd":"","userLang":"","fromLang":"","toLang":"","queryText":""}`,
      512, 0
    );
    console.log(`[INTENT] "${text.slice(0,30)}" → ${r.cmd} [${r.userLang}]`);
    if (r.cmd === 'UNKNOWN') unknownCache.set(ck, Date.now());
    return r;
  } catch(e) {
    console.error('[INTENT ERR]', e.message?.slice(0,60));
    unknownCache.set(ck, Date.now());
    return {cmd:'UNKNOWN',userLang:'Arabic',fromLang:'',toLang:'',queryText:''};
  }
}

async function evalAnswer(game, playerMsg) {
  if (game.type === 'GAME_GRAMMAR') return evalGrammar(game, playerMsg);
  try {
    const isText  = game.type === 'GAME_TR_TEXT';
    const maxPts  = isText ? 30 : 10;
    const ansLang = game.lang || game.fromLang || 'Arabic';
    let context = '';
    if (game.type === 'GAME_GUESS') {
      context =
`GAME TYPE: Word guessing game
The player was shown this DESCRIPTION/CLUE in ${ansLang}: "${game.display.slice(0,300)}"
The player must GUESS THE WORD that matches this description.
Correct word: "${game.answer}"
Player's guess: "${playerMsg}"
RULES: Accept the exact word, common spelling variations, or very close synonyms. Do NOT accept unrelated words.`;
    } else if (game.type === 'GAME_WORD') {
      context =
`GAME TYPE: Word meaning game
The player was shown this WORD in ${ansLang}: "${game.question}"
The player must EXPLAIN THE MEANING of this word.
Reference meaning: "${game.answer.slice(0,300)}"
Player's explanation: "${playerMsg}"
RULES: Accept any explanation that correctly captures the core meaning. Accept synonyms, partial definitions, paraphrasing.`;
    } else if (game.type === 'GAME_TR_WORD') {
      context =
`GAME TYPE: Word translation game
The player was shown this word in ${game.fromLang}: "${game.question}"
The player must translate it to ${game.toLang}.
Correct translation: "${game.answer}"
Player's translation: "${playerMsg}"
RULES: Accept exact translation, spelling variations, synonyms with same meaning.`;
    } else if (game.type === 'GAME_TR_SENT') {
      context =
`GAME TYPE: Sentence translation game
The player was shown this sentence in ${game.fromLang}: "${game.question.slice(0,300)}"
The player must translate it to ${game.toLang}.
Reference translation: "${game.answer.slice(0,300)}"
Player's translation: "${playerMsg.slice(0,300)}"
RULES: Accept any translation that conveys the same meaning, even if worded differently.`;
    } else if (game.type === 'GAME_TR_TEXT') {
      context =
`GAME TYPE: Paragraph translation game
The player was shown this paragraph in ${game.fromLang}: "${game.question.slice(0,400)}"
The player must translate it to ${game.toLang}.
Reference translation: "${game.answer.slice(0,400)}"
Player's translation: "${playerMsg.slice(0,400)}"
RULES: Grade based on overall meaning accuracy. Accept paraphrasing.`;
    }
    const raw = await gemini(
`You are a fair language game judge. Grade the player's answer strictly according to the game context below.

${context}

GRADING SCALE:
- Completely wrong or unrelated = 0-20%
- Vaguely related but mostly wrong = 25-39%
- Partially correct, shows some understanding = 40-65%
- Mostly correct with minor issues = 70-85%
- Perfect or near-perfect = 90-100%

Max points: ${maxPts} — pts = round(pct/100 × ${maxPts})
Reply with ONLY this exact line (no extra text):
pct=XX pts=YY diff=سهل/متوسط/صعب ok=true/false feedback=ONE_SENTENCE_IN_${ansLang}`,
      200, 0
    );
    const pct    = parseInt(raw.match(/pct=(\d+)/)?.[1]  || '0');
    const rawPts = parseInt(raw.match(/pts=(\d+)/)?.[1]  || '0');
    const pts    = Math.min(rawPts, maxPts);
    const diff   = raw.match(/diff=([^\s]+)/)?.[1]        || 'متوسط';
    const ok     = /ok=true/i.test(raw);
    const fb     = raw.match(/feedback=(.+)/)?.[1]?.trim() || '';
    console.log(`[EVAL] type=${game.type} pct=${pct} pts=${pts} ok=${ok} max=${maxPts}`);
    return { correct: ok || pct>=40, pct, pts, difficulty:2, diffLabel:diff, feedback:fb };
  } catch(e) {
    console.error('[EVAL ERR]', e.message?.slice(0,80));
    return { correct:false, pct:0, pts:0, difficulty:1, diffLabel:'', feedback:'' };
  }
}

async function evalGrammar(game, playerMsg) {
  try {
    const raw = await gemini(
`Grammar analysis judge. Sentence: "${game.question.slice(0,150)}"
Player's analysis: "${playerMsg.slice(0,300)}"
GRADING SCALE (medium difficulty):
- Completely wrong or irrelevant = 0-20%
- Mentions one grammar term but mostly wrong = 30-40%
- Partial analysis, some correct roles = 50-65%
- Good analysis, most roles correct = 70-84%
- Complete and accurate analysis = 85-100%
Be fair but not overly strict. Reward genuine effort.
Reply with ONLY: pct=XX pts=YY feedback=SHORT_ARABIC_SENTENCE`,
      120, 0
    );
    const rawPct = parseInt(raw.match(/pct=(\d+)/)?.[1] || '0');
    const pct = playerMsg.trim().length > 3 ? Math.max(rawPct, 30) : rawPct;
    const pts = Math.min(Math.round(pct/100*10), 10);
    const fb  = raw.match(/feedback=(.+)/)?.[1]?.trim() || 'حاول مجدداً! 💪';
    console.log(`[GRAMMAR EVAL] pct=${pct} pts=${pts}`);
    return { correct: pct>=40, pct, pts, difficulty:2, diffLabel:'متوسط', feedback:fb };
  } catch(e) {
    const defaultPct = playerMsg.trim().length > 3 ? 40 : 0;
    return { correct: defaultPct>=40, pct:defaultPct, pts:Math.round(defaultPct/100*10),
             difficulty:2, diffLabel:'متوسط', feedback:'محاولة جيدة! 👍' };
  }
}

const WORD_TOPICS   = ['nature','animals','food','emotions','science','geography','history','technology','sports','art','human body','weather','space','ocean','plants','music','architecture','literature','philosophy','medicine'];
const SENT_TOPICS   = ['wisdom & proverbs','daily life','science facts','geography','historical events','nature wonders','technology','health tips','culture & traditions','economics','psychology','environment','education','famous quotes','sports'];
const TEXT_TOPICS   = ['ancient civilizations','space exploration','natural phenomena','great inventors','world literature','ocean life','human psychology','environmental challenges','famous historical events','cultural heritage','medical breakthroughs','philosophical ideas','notable scientists','wildlife','economic history'];
const GRAMMAR_TOPICS= ['daily activities','travel & transportation','family & relationships','work & career','education','food & cooking','weather & seasons','sports & hobbies','nature & environment','science & technology'];
function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

async function makeQ(type, lang, fromLang, toLang) {
  const gl = lang||fromLang||'Arabic';
  const fl = fromLang||gl;
  const tl = toLang||'English';

  function parseKV(raw, k1, k2) {
    const text = raw
      .replace(/\r\n/g,'\n').replace(/\r/g,'\n')
      .replace(/\*\*([^*]+)\*\*/g,'$1')
      .replace(/\*([^*]+)\*/g,'$1')
      .replace(/`([^`]+)`/g,'$1');
    const k2Re = new RegExp('(?:^|\\n)[\\s*]*'+k2+'[\\s*]*:[\\s*]*', 'i');
    const k1Re = new RegExp('(?:^|\\n)[\\s*]*'+k1+'[\\s*]*:[\\s*]*', 'i');
    const k2Match = k2Re.exec(text);
    if (!k2Match) {
      console.warn('[PARSEKV] k2 not found:', k2, '| raw:', text.slice(0,120));
      throw new Error('k2 not found: '+k2);
    }
    const v2 = text.slice(k2Match.index + k2Match[0].length).trim();
    const before = text.slice(0, k2Match.index);
    const k1Match = k1Re.exec(before);
    const v1 = k1Match ? before.slice(k1Match.index + k1Match[0].length).trim() : before.trim();
    if (!v1 || !v2) throw new Error('empty value k1='+k1+' k2='+k2);
    return [v1, v2];
  }

  if (type==='GAME_GUESS') {
    const topic = pick(WORD_TOPICS);
    return gemini(
`Choose one unique ${gl} word related to the topic: "${topic}".
Describe its meaning in 1-2 sentences in ${gl} WITHOUT mentioning the word. Be creative and pick uncommon words.
Reply ONLY in this format:
WORD: [the word in ${gl}]
MEANING: [the description in ${gl}]`, 200, 0.95
    ).then(raw => {
      console.log('[RAW GUESS]', raw.slice(0,120));
      const [word, meaning] = parseKV(raw,'WORD','MEANING');
      return {question:word, answer:word, display:meaning};
    });
  }

  if (type==='GAME_WORD') {
    const topic = pick(WORD_TOPICS);
    return gemini(
`Choose one interesting ${gl} word related to the topic: "${topic}". Pick a varied and educational word.
Write its meaning in 1-2 sentences in ${gl}.
Reply ONLY in this format:
WORD: [the word in ${gl}]
MEANING: [the meaning in ${gl}]`, 200, 0.95
    ).then(raw => {
      console.log('[RAW WORD]', raw.slice(0,120));
      const [word, meaning] = parseKV(raw,'WORD','MEANING');
      return {question:word, answer:meaning, display:word};
    });
  }

  if (type==='GAME_TR_WORD') {
    const topic = pick(WORD_TOPICS);
    return gemini(
`Give one ${fl} word related to the topic: "${topic}" and its ${tl} translation. Vary the word each time.
Reply ONLY in this format:
WORD: [the word in ${fl}]
TRANSLATION: [the translation in ${tl}]`, 100, 0.95
    ).then(raw => {
      const [word, trans] = parseKV(raw,'WORD','TRANSLATION');
      return {question:word, answer:trans, display:word};
    });
  }

  if (type==='GAME_TR_SENT') {
    const topic = pick(SENT_TOPICS);
    return gemini(
`Write one original educational sentence (max 12 words) in ${fl} about: "${topic}". Make it unique every time. No politics/religion/adult.
Then give its ${tl} translation.
Reply ONLY in this format:
SENTENCE: [the sentence in ${fl}]
TRANSLATION: [the translation in ${tl}]`, 200, 0.95
    ).then(raw => {
      const [sent, trans] = parseKV(raw,'SENTENCE','TRANSLATION');
      return {question:sent, answer:trans, display:sent};
    });
  }

  if (type==='GAME_TR_TEXT') {
    const topic = pick(TEXT_TOPICS);
    return gemini(
`Write a unique educational paragraph (3-5 sentences) in ${fl} about: "${topic}". Make it original and interesting. No politics/religion/adult.
Then write its complete ${tl} translation.
Reply ONLY in this format:
TEXT: [the paragraph in ${fl}]
TRANSLATION: [the translation in ${tl}]`, 700, 0.95
    ).then(raw => {
      const [text, trans] = parseKV(raw,'TEXT','TRANSLATION');
      return {question:text, answer:trans, display:text};
    });
  }

  if (type==='GAME_GRAMMAR') {
    const topic = pick(GRAMMAR_TOPICS);
    return gemini(
`Write one original ${gl} sentence (5-8 words) about "${topic}" suitable for grammar analysis. Make it varied and educational.
Then write a brief grammatical analysis (2-3 lines) in ${gl}.
Reply ONLY in this format:
SENTENCE: [the sentence]
ANALYSIS: [the analysis]`, 300, 0.95
    ).then(raw => {
      const [sent, analysis] = parseKV(raw,'SENTENCE','ANALYSIS');
      return {question:sent, answer:analysis, display:sent};
    });
  }
  throw new Error('Unknown type: '+type);
}

const LABEL = {
  GAME_GUESS:'🔍 خمّن الكلمة:', GAME_WORD:'📖 اشرح معنى:',
  GAME_TR_WORD:'🌐 ترجم:', GAME_TR_SENT:'📝 ترجم الجملة:',
  GAME_TR_TEXT:'📄 ترجم النص:', GAME_GRAMMAR:'✏️ أعرب:',
};

function io(cid) {
  const send  = t => client.messaging.sendChannelMessage(cid,t,{formatting:{me:true}}).catch(()=>{});
  const alert = t => client.messaging.sendChannelMessage(cid,t,{formatting:{alert:true}}).catch(()=>{});
  return {send,alert};
}

const GAME_IDLE_MS = 5 * 60 * 1000;

function endGame(cid) {
  if (games[cid]?.idleTimer) clearTimeout(games[cid].idleTimer);
  delete games[cid];
  delete pregenQ[cid];
}

function resetIdleTimer(cid) {
  const g = games[cid];
  if (!g) return;
  if (g.idleTimer) clearTimeout(g.idleTimer);
  g.idleTimer = setTimeout(async () => {
    if (!games[cid]) return;
    const ans    = games[cid].answer;
    const isAuto = autoSt[cid]?.active;
    endGame(cid);
    if (isAuto) endAuto(cid);
    const {send} = io(cid);
    if (isAuto) {
      await send(`⏰ مرّت 5 دقائق بدون نشاط.\n✅ الإجابة كانت: ${ans}\n\n🔴 تم إيقاف الوضع التلقائي — ابدأ من جديد عند الاستعداد.`);
    } else {
      await send(`⏰ انتهى وقت السؤال!\n✅ الإجابة: ${ans}`);
    }
    console.log(`[IDLE TIMEOUT] cid=${cid} auto=${isAuto} → stopped`);
  }, GAME_IDLE_MS);
}
function endAuto(cid) { delete autoSt[cid]; }

async function startGame(cid, type, lang, fromLang, toLang) {
  console.log(`[START GAME] type=${type} lang=${lang} fl=${fromLang} tl=${toLang}`);
  endGame(cid);
  const {send,alert} = io(cid);
  await send('⏳...');
  let q;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pre = pregenQ[cid];
      if (attempt === 1 && pre?.type===type) { q=pre; delete pregenQ[cid]; break; }
      q = await makeQ(type, lang, fromLang, toLang);
      break;
    } catch(e) {
      console.error(`[MAKEQ ERR attempt=${attempt}]`, type, e.message?.slice(0,80));
      if (attempt === 3) { await alert('⚠️ حدث خطأ، حاول مجدداً.'); return; }
      await sleep(1500);
    }
  }
  if (!q) return;
  games[cid] = {type,lang,fromLang,toLang,...q};
  resetIdleTimer(cid);
  makeQ(type,lang,fromLang,toLang).then(nq=>{ pregenQ[cid]={type,...nq}; }).catch(()=>{});
  const arrow = ['GAME_TR_WORD','GAME_TR_SENT','GAME_TR_TEXT'].includes(type) ? ` (${fromLang}→${toLang})` : '';
  await send(`${LABEL[type]||'🎮'}${arrow}\n\n${q.display}\n\n💡 اكتب # قبل إجابتك`);
}

async function toggleAuto(cid, type, lang, fromLang, toLang) {
  const {send} = io(cid);
  if (autoSt[cid]?.active && autoSt[cid]?.type===type) {
    endAuto(cid); endGame(cid);
    await send('❌ الوضع التلقائي أُوقف');
  } else {
    endAuto(cid);
    autoSt[cid] = {active:true,type,lang,fromLang,toLang};
    await send('✅ الوضع التلقائي مفعّل 🔄\n💡 السؤال التالي يأتي فقط بعد الإجابة الصحيحة أو !لغه التالي');
    await startGame(cid, type, lang, fromLang, toLang);
  }
}

const HELP_TEXT =
`🤖 بوت اللغة | الأوامر تعمل بأي لغة 🌍
━━━━━━━━━━━━━━━━━━━━
💡 للإجابة في الألعاب: اكتب # قبل إجابتك
   مثال: #مرحبا أو #hello
━━━━━━━━━━━━━━━━━━━━
🔍 !معنى {كلمة}
🌐 !ترجمه {اللغة} {النص}
━━━━━━━━━━━━━━━━━━━━
🎮 بدء الألعاب:
• !معرفات بدء
• !معاني بدء
• !كلمه {من لغه} {إلى لغه} بدء
• !جمله {من لغه} {إلى لغه} بدء
• !نص {من لغه} {إلى لغه} بدء
• !اعرب بدء
━━━━━━━━━━━━━━━━━━━━
🔄 الوضع التلقائي (تشغيل/إيقاف):
• !معرفات تلقائي
• !معاني تلقائي
• !كلمه تلقائي
• !جمله تلقائي
• !نص تلقائي
• !اعرب تلقائي
⚠️ يتوقف الوضع التلقائي تلقائياً بعد 5 دقائق بدون نشاط
━━━━━━━━━━━━━━━━━━━━
⏭️ !لغه التالي
🏆 !لغه مجموع
📊 !لغه ترتيب قناه
🌍 !لغه ترتيب ولف
📋 !لغه مساعده`;

const client = new WOLF();
let _connected   = false;
let _reconnDelay = 5000;
const MAX_DELAY  = 60000;

function scheduleReconnect(reason) {
  console.warn(`[RECONNECT] ${reason} — محاولة بعد ${_reconnDelay/1000}s`);
  setTimeout(() => {
    client.login(BOT_EMAIL, BOT_PASS).catch(e => console.error('[LOGIN ERR]', e.message));
  }, _reconnDelay);
  _reconnDelay = Math.min(_reconnDelay * 2, MAX_DELAY);
}

client.on('ready', () => { console.log('[BOT] ✅ متصل!'); _connected = true; _reconnDelay = 5000; });
client.on('loginFailed', r  => { _connected = false; scheduleReconnect(`loginFailed: ${r}`); });
client.on('disconnected', r => { _connected = false; scheduleReconnect(`disconnected: ${r}`); });

setInterval(() => {
  if (!_connected) {
    console.warn('[WATCHDOG] غير متصل — إعادة محاولة الاتصال...');
    client.login(BOT_EMAIL, BOT_PASS).catch(e => console.error('[WATCHDOG ERR]', e.message));
  }
}, 2 * 60 * 1000);

client.on('channelMessage', async (msg) => {
  const cid  = msg.targetChannelId;
  const uid  = msg.sourceSubscriberId;
  const text = (msg.body||'').trim();
  if (!text) return;

  const isCmd   = text.startsWith('!') || text.startsWith('！');
  const isAns   = text.startsWith('#');
  const hasGame = !!games[cid];

  if (!hasGame && !isCmd) return;
  if (hasGame && !isCmd && !isAns) return;

  const {send,alert} = io(cid);

  if (hasGame && isAns) {
    const key = `${cid}_${uid}`;
    if (lastAns[key] && Date.now()-lastAns[key]<3000) return;
    if (busy[cid]) return;
    busy[cid] = true;
    const busyGuard = setTimeout(() => { busy[cid] = false; }, 20000);
    lastAns[key] = Date.now();
    const answerText = text.slice(1).trim();
    if (!answerText) { busy[cid]=false; clearTimeout(busyGuard); return; }
    try {
      await send('📝 جاري فحص الإجابة ...');
      const ev = await evalAnswer(games[cid], answerText);
      const diff = ev.diffLabel ? ` | ${ev.diffLabel}` : '';
      if (ev.correct || ev.pct>=30) {
        let name = String(uid);
        try { const s = await client.subscriber.getById(uid); if(s?.nickname) name=s.nickname; } catch(e){}
        getPlayer(uid, name, cid);
        addPts(uid, ev.pts||3, cid);
        db = loadDB();
        const total = db.players[String(uid)]?.pts||0;
        const bar = '█'.repeat(Math.round(ev.pct/10)) + '░'.repeat(10-Math.round(ev.pct/10));
        await send(`✅ ${ev.pct}%${diff}\n${bar}\n+${ev.pts} نقطة 🎊\n💬 ${ev.feedback}\n🏆 ${name}: ${total} نقطة`);
        endGame(cid);
        setTimeout(()=>{ if(autoSt[cid]?.active) runAutoNow(cid); }, 2000);
      } else {
        const bar = '█'.repeat(Math.round(ev.pct/10)) + '░'.repeat(10-Math.round(ev.pct/10));
        await alert(`❌ ${ev.pct}%${diff}\n${bar}\n💬 ${ev.feedback}`);
      }
    } finally { clearTimeout(busyGuard); busy[cid]=false; }
    return;
  }

  if (!isCmd) return;
  const intent = fastDetect(text) || await detectIntent(text);
  if (!intent || intent.cmd==='UNKNOWN') return;

  const {cmd,userLang,fromLang,toLang,queryText} = intent;
  const lang = userLang||'Arabic';
  const fl   = fromLang||lang;
  const tl   = toLang||'English';

  if (cmd==='HELP') { await send(HELP_TEXT); return; }

  if (cmd==='MY_SCORE') {
    const p = db.players[String(uid)];
    await send(`🏆 ${p?.name||String(uid)}: ${p?.pts||0} نقطة`);
    return;
  }

  if (cmd==='RANK_CHANNEL') {
    const list = realPlayersInChannel(cid).slice(0,10);
    if (!list.length) { await send('📊 لا يوجد لاعبون في هذه القناة بعد!'); return; }
    await send('🏆 أفضل 10 لاعبين في هذه القناة:\n'+list.map((p,i)=>`${i+1}- ${p.name} — ${p.pts} نقطة`).join('\n'));
    return;
  }

  if (cmd==='RANK_GLOBAL') {
    const all = realPlayers();
    if (!all.length) { await send('🌍 لا يوجد لاعبون بعد!'); return; }
    const top10 = all.slice(0,10);
    const idx   = all.findIndex(p=>String(p.id)===String(uid));
    const myRank = idx>=0 ? `\n\n📍 ترتيبك: #${idx+1} من ${all.length} لاعب` : '';
    await send('🌍 أفضل 10 لاعبين عالمياً:\n'+top10.map((p,i)=>`${i+1}- ${p.name} — ${p.pts} نقطة`).join('\n')+myRank);
    return;
  }

  if (cmd==='NEXT') {
    if (autoSt[cid]?.active) { await runAutoNow(cid); return; }
    if (hasGame) {
      await startGame(cid, games[cid].type, games[cid].lang, games[cid].fromLang, games[cid].toLang);
      return;
    }
    await send('⚠️ لا توجد لعبة الآن.');
    return;
  }

  const AUTO_MAP = {
    AUTO_GAME_GUESS: 'GAME_GUESS', AUTO_GAME_WORD: 'GAME_WORD',
    AUTO_GAME_TR_WORD: 'GAME_TR_WORD', AUTO_GAME_TR_SENT: 'GAME_TR_SENT',
    AUTO_GAME_TR_TEXT: 'GAME_TR_TEXT', AUTO_GAME_GRAMMAR: 'GAME_GRAMMAR',
  };
  if (AUTO_MAP[cmd]) {
    const newType = AUTO_MAP[cmd];
    const curAuto = autoSt[cid];
    if (curAuto?.active && curAuto.type !== newType) {
      await send(`⚠️ يوجد وضع تلقائي نشط: ${LABEL[curAuto.type]||curAuto.type}\nأوقفه أولاً بنفس الأمر قبل بدء نوع آخر.`);
      return;
    }
    await toggleAuto(cid, newType, lang, fl, tl);
    return;
  }

  const GAME_CMDS = ['GAME_GUESS','GAME_WORD','GAME_TR_WORD','GAME_TR_SENT','GAME_TR_TEXT','GAME_GRAMMAR'];
  if (GAME_CMDS.includes(cmd)) {
    if (autoSt[cid]?.active) {
      await send(`⚠️ الوضع التلقائي نشط: ${LABEL[autoSt[cid].type]||autoSt[cid].type}\nأوقفه أولاً قبل بدء لعبة يدوية.`);
      return;
    }
    await startGame(cid, cmd, lang, fl, tl);
    return;
  }

  if (cmd==='MEANING') {
    const q = queryText||text.replace(/^[!！]\S+\s*/,'').trim();
    if (!q) return;
    if (isVulgar(q)) { await alert('مخالفة ⚠️'); return; }
    await send('⏳...');
    try {
      const ans = await gemini(`Define "${q}" in ${lang}. Reply in ONE sentence only, max 15 words. No labels, no extra text.`, 80, 0.3);
      await send(`📚 ${ans}`);
    } catch(e) { await alert('⚠️ خطأ، حاول مجدداً.'); }
    return;
  }

  if (cmd==='TRANSLATE') {
    const q = queryText||text.replace(/^[!！]\S+\s*/,'').trim();
    if (!q) return;
    if (isVulgar(q)) { await alert('مخالفة ⚠️'); return; }
    await send('⏳...');
    try {
      const ans = await gemini(`Translate to ${tl}. Return ONLY the translation:\n${q}`, 300, 0.3);
      await send(`🌐 ${ans}`);
    } catch(e) { await alert('⚠️ خطأ، حاول مجدداً.'); }
  }
});

async function runAutoNow(cid) {
  const a = autoSt[cid];
  if (!a?.active) return;
  await startGame(cid, a.type, a.lang, a.fromLang, a.toLang);
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`🤖 Wolf Bot يعمل | متصل=${_connected} | ${new Date().toLocaleString('ar')}`);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] خادم الإبقاء يعمل على المنفذ ${PORT}`);
});

const SELF_URL = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : `http://localhost:${PORT}`;

setInterval(async () => {
  try {
    const r = await fetch(SELF_URL, { signal: AbortSignal.timeout(10000) });
    console.log(`[PING] ذاتي → ${r.status} ✓`);
  } catch (e) {
    console.warn(`[PING] فشل: ${e.message}`);
  }
}, 4 * 60 * 1000);

process.on('uncaughtException', e => {
  console.error('[CRASH]', e.message);
  if (!_connected) scheduleReconnect('uncaughtException');
});
process.on('unhandledRejection', e => {
  console.error('[REJ]', String(e).slice(0, 120));
});

setInterval(() => console.log(`[💓] ${new Date().toLocaleTimeString('ar')} | متصل=${_connected}`), 60000);

console.log('[BOT] 🚀 جاري التشغيل...');
client.login(BOT_EMAIL, BOT_PASS).catch(e => {
  console.error('[LOGIN ERR]', e.message);
  scheduleReconnect('initial login failed');
});
