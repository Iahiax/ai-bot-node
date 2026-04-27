import { WOLF } from 'wolf.js';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
// @xenova/transformers — اختياري: يُثبَّت بـ "npm install @xenova/transformers"
// إذا لم يكن مثبّتاً، يعمل البوت بالمطابقة النصية العادية (احتياط آمن)
let pipeline, env;
try {
  const xeno = await import('@xenova/transformers');
  pipeline = xeno.pipeline;
  env      = xeno.env;
  console.log('[AI] ✅ @xenova/transformers متاح — نماذج AI مُفعَّلة');
} catch(e) {
  console.warn('[AI] ⚠️ @xenova/transformers غير مثبّت — يعمل بالمطابقة النصية العادية');
  console.warn('[AI]    لتفعيل AI: npm install @xenova/transformers');
  pipeline = null;
  env      = null;
}

// ╔══════════════════════════════════════════════════════════╗
// ║           ⚙️  إعدادات البوت — عدّل هذا القسم            ║
// ╚══════════════════════════════════════════════════════════╝
const BOT_EMAIL = 'scodoublet@yahoo.com'; // إيميل الحساب
const BOT_PASS  = '12345';                // كلمة المرور
// ═══════════════════════════════════════════════════════════

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'players.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
//  🤖  محرك الترجمة الذكي — Hugging Face Transformers.js (محلي، بدون إنترنت)
//  • نماذج Helsinki-NLP/opus-mt تُنزَّل تلقائياً أول مرة (~80MB لكل لغة)
//  • تعمل بعد ذلك بدون أي اتصال إنترنت
//  • تدعم: عربي ↔ إنجليزي، فرنسي، إسباني، ألماني، إيطالي، روسي، تركي، هولندي
// ══════════════════════════════════════════════════════════════════════════════

// مجلد تخزين النماذج المحلية (فقط إذا كانت المكتبة متاحة)
if (env) {
  env.cacheDir          = path.join(__dirname, 'models');
  env.allowRemoteModels = true;
}

// خريطة النماذج المتاحة (من-إلى → اسم النموذج على Hugging Face)
const MODEL_MAP = {
  'en-ar': 'Xenova/opus-mt-en-ar',
  'ar-en': 'Xenova/opus-mt-ar-en',
  'en-fr': 'Xenova/opus-mt-en-fr',
  'fr-en': 'Xenova/opus-mt-fr-en',
  'en-es': 'Xenova/opus-mt-en-es',
  'es-en': 'Xenova/opus-mt-es-en',
  'en-de': 'Xenova/opus-mt-en-de',
  'de-en': 'Xenova/opus-mt-de-en',
  'en-it': 'Xenova/opus-mt-en-it',
  'it-en': 'Xenova/opus-mt-it-en',
  'en-ru': 'Xenova/opus-mt-en-ru',
  'ru-en': 'Xenova/opus-mt-ru-en',
  'en-tr': 'Xenova/opus-mt-en-tr',
  'tr-en': 'Xenova/opus-mt-tr-en',
  'en-nl': 'Xenova/opus-mt-en-nl',
  'nl-en': 'Xenova/opus-mt-nl-en',
  'en-pt': 'Xenova/opus-mt-en-ROMANCE', // إسباني/فرنسي/برتغالي/إيطالي
  'ar-fr': null, // عبر الإنجليزي
  'ar-de': null, // عبر الإنجليزي
  'ar-es': null, // عبر الإنجليزي
};

// ذاكرة تخزين النماذج المحمّلة (تحميل كسول — فقط عند الطلب)
const _aiPipes = {};

async function loadTranslator(from, to) {
  if (!pipeline) return null;                 // @xenova/transformers غير مثبّت
  const k = `${from}-${to}`;
  if (!MODEL_MAP[k]) return null;             // لا يوجد نموذج مباشر
  if (_aiPipes[k])   return _aiPipes[k];      // مُحمَّل مسبقاً
  console.log(`[AI] ⏳ تحميل نموذج ${from}→${to} (مرة واحدة فقط)...`);
  try {
    _aiPipes[k] = await pipeline('translation', MODEL_MAP[k], { quantized: true });
    console.log(`[AI] ✅ نموذج ${from}→${to} جاهز`);
    return _aiPipes[k];
  } catch(e) {
    console.warn(`[AI] ⚠️ فشل تحميل ${k}:`, e.message?.slice(0,60));
    return null;
  }
}

// الترجمة بالنموذج المحلي (مع pivot عبر الإنجليزي للأزواج غير المباشرة)
async function localTranslate(text, fromCode, toCode) {
  if (!text || fromCode === toCode) return null;
  try {
    // ① ترجمة مباشرة
    const direct = await loadTranslator(fromCode, toCode);
    if (direct) {
      const r = await direct(text, { max_new_tokens: 128 });
      return r?.[0]?.translation_text?.trim() || null;
    }
    // ② ترجمة عبر الإنجليزي (pivot)
    if (fromCode !== 'en' && toCode !== 'en') {
      const tr1 = await loadTranslator(fromCode, 'en');
      const tr2 = await loadTranslator('en', toCode);
      if (tr1 && tr2) {
        const mid = await tr1(text, { max_new_tokens: 128 });
        const midText = mid?.[0]?.translation_text?.trim();
        if (midText) {
          const r = await tr2(midText, { max_new_tokens: 128 });
          return r?.[0]?.translation_text?.trim() || null;
        }
      }
    }
  } catch(e) {
    console.warn('[AI-TR]', e.message?.slice(0,60));
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  🔍  محرك البحث الحر — DuckDuckGo (مجاني، بلا مفاتيح، محتوى جديد في كل مرة)
// ══════════════════════════════════════════════════════════════════════════════
async function duckSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=wolfbot`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return {
      abstract:  d.AbstractText   || '',
      definition:d.Definition     || '',
      topics:   (d.RelatedTopics||[]).map(t=>t.Text||'').filter(s=>s.length>20).slice(0,6),
      answer:    d.Answer          || '',
    };
  } catch(e) {
    console.warn('[DDG]', e.message?.slice(0,50));
    return { abstract:'', definition:'', topics:[], answer:'' };
  }
}

// بحث عن جملة عربية عشوائية من القرآن/الأحاديث/ويكيبيديا العربية
const AR_SENTENCE_SOURCES = [
  // ويكيبيديا عربية — مقالات عشوائية
  () => fetch('https://ar.wikipedia.org/api/rest_v1/page/random/summary',
              { signal: AbortSignal.timeout(10000) }).then(r=>r.json()),
  // ويكيبيديا عربية — أخبار اليوم
  () => fetch('https://ar.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=5&format=json&origin=*',
              { signal: AbortSignal.timeout(10000) }).then(r=>r.json()),
];

async function fetchArabicSentence() {
  for (let i = 0; i < 10; i++) {
    try {
      const src = AR_SENTENCE_SOURCES[Math.floor(Math.random()*AR_SENTENCE_SOURCES.length)];
      const d   = await src();
      const extract = d?.extract || '';
      // جمل مختصرة: 20-75 حرف عربي فقط، لا رموز غريبة
      const sents = (extract)
        .split(/[.؟!،]\s+/)
        .map(s => s.trim().replace(/\s+/g,' '))
        .filter(s =>
          s.length >= 20 && s.length <= 75 &&
          /[\u0600-\u06FF]{5,}/.test(s) &&
          !/https?:|www\.|ISBN|[0-9]{4}/.test(s)
        );
      if (sents.length === 0) continue;
      return sents[Math.floor(Math.random()*Math.min(4, sents.length))];
    } catch(e) {
      await new Promise(r=>setTimeout(r,800));
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  🎯  تقييم الإجابات بالذكاء الاصطناعي — نموذج التشابه الدلالي المتعدد اللغات
//  paraphrase-multilingual-MiniLM-L12-v2 (~120MB) — يفهم المعنى لا مجرد الحروف
// ══════════════════════════════════════════════════════════════════════════════
let _simPipe = null;

async function loadSimilarityModel() {
  if (!pipeline) return null;                 // @xenova/transformers غير مثبّت
  if (_simPipe) return _simPipe;
  console.log('[AI] ⏳ تحميل نموذج تقييم الإجابات (مرة واحدة فقط)...');
  try {
    _simPipe = await pipeline(
      'feature-extraction',
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      { quantized: true }
    );
    console.log('[AI] ✅ نموذج التقييم جاهز — يفهم المعنى بـ 50+ لغة');
    return _simPipe;
  } catch(e) {
    console.warn('[AI-SIM]', e.message?.slice(0,60));
    return null;
  }
}

function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++) { dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb)+1e-9);
}

// تقييم ذكي: يقارن المعنى لا الحروف — يفهم المرادفات والتصريفات
async function aiScore(expected, given) {
  try {
    const model = await loadSimilarityModel();
    if (!model) return null;
    const [eOut, gOut] = await Promise.all([
      model(expected, { pooling:'mean', normalize:true }),
      model(given,    { pooling:'mean', normalize:true }),
    ]);
    const sim = cosine(Array.from(eOut.data), Array.from(gOut.data));
    return Math.round(Math.min(1, Math.max(0, sim)) * 100);
  } catch(e) {
    console.warn('[AI-SCORE]', e.message?.slice(0,50));
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  🤖  النموذج اللغوي المحلي الكامل — Flan-T5-Base (~250MB)
//  • يولّد معاني الكلمات، التعريفات، الجمل، تحليل الإعراب
//  • يعمل بـ 100+ لغة بما فيها العربية — بدون إنترنت بعد التنزيل الأول
//  • يعمل مثل وكيل ذكاء اصطناعي: يفهم التعليمات ويولّد إجابات طبيعية
// ══════════════════════════════════════════════════════════════════════════════
let _qaModel = null;

async function loadQAModel() {
  if (!pipeline) return null;
  if (_qaModel)  return _qaModel;
  console.log('[AI] ⏳ تحميل النموذج اللغوي flan-t5-base (~250MB) — مرة واحدة فقط...');
  try {
    _qaModel = await pipeline(
      'text2text-generation',
      'Xenova/flan-t5-base',
      { quantized: true }
    );
    console.log('[AI] ✅ النموذج اللغوي جاهز — يولّد معاني وتعريفات وإعراباً');
    return _qaModel;
  } catch(e) {
    console.warn('[AI-QA] فشل تحميل النموذج اللغوي:', e.message?.slice(0,60));
    return null;
  }
}

// توليد نص من النموذج اللغوي (greedy — أسرع بكثير من do_sample)
async function localGenerate(prompt, maxTokens = 80, requireLoaded = false) {
  try {
    // requireLoaded: لا تنتظر تحميل النموذج (لو مش محمّل ارجع null فوراً)
    if (requireLoaded && !_qaModel) return null;
    const model = await loadQAModel();
    if (!model) return null;
    const out = await model(prompt, {
      max_new_tokens: maxTokens,
      // greedy decoding (بدون do_sample) — أسرع 3x
    });
    const text = out?.[0]?.generated_text?.trim() || '';
    // قطع عند أول نقطة إذا كان النص طويلاً
    const first = text.split(/[.!?]/)[0].trim();
    return first.length > 3 ? first : (text.length > 3 ? text : null);
  } catch(e) {
    console.warn('[LOCAL-GEN]', e.message?.slice(0,50));
    return null;
  }
}

// ─── معنى الكلمة بالنموذج المحلي — جملة واحدة مختصرة ───────────────────────
async function localWordMeaning(word, langCode) {
  // لا نحتاج flan-t5 جاهزاً مسبقاً هنا (المستخدم ينتظر عمداً)
  // لكن إذا فشل التحميل نُرجع null للاحتياط
  if (langCode === 'ar') {
    const enWord = await localTranslate(word, 'ar', 'en');
    const target = enWord && enWord !== word ? enWord : word;
    const enDef  = await localGenerate(`In one sentence, define "${target}":`, 65);
    if (!enDef) return null;
    const arDef  = enWord ? await localTranslate(enDef, 'en', 'ar') : null;
    if (arDef && arDef.length > 8) {
      return enWord && enWord !== word ? `(${enWord}) ${arDef}` : arDef;
    }
    return enDef;
  }
  return await localGenerate(`In one sentence, define "${word}":`, 65);
}

// ─── توليد تعريف للألعاب — أول سطر يفحص النموذج، لا ينتظر أي تحميل ──────────
async function localMakeDefinition(word, langCode) {
  if (!_qaModel) return null; // ← فحص فوري قبل أي شيء — لا نماذج جاهزة

  if (langCode === 'ar') {
    // الترجمة اختيارية — إذا فشلت نستخدم الكلمة مباشرة
    const enWord = _aiPipes['ar-en']
      ? (await localTranslate(word, 'ar', 'en') || word)
      : word;
    const def = await localGenerate(
      `Define "${enWord}" in one sentence without saying the word:`, 60, true
    );
    if (!def) return null;
    // ترجمة الناتج للعربي إذا كان النموذج جاهزاً
    const arDef = _aiPipes['en-ar']
      ? await localTranslate(def, 'en', 'ar')
      : null;
    return arDef || def;
  }
  return await localGenerate(
    `Define "${word}" in one sentence without saying the word:`, 60, true
  );
}

// ─── تحليل إعراب الجملة بالنموذج المحلي ─────────────────────────────────────
async function localGrammarAnalysis(sentence) {
  // ترجمة الجملة العربية للإنجليزي أولاً
  const enSent = await localTranslate(sentence, 'ar', 'en') || sentence;
  const prompt = `Analyze the grammatical structure of this sentence: "${enSent}". Identify subject, verb, object, and other parts:`;
  const analysis = await localGenerate(prompt, 180);
  if (!analysis) return null;
  // ترجمة التحليل للعربي
  const arAnalysis = await localTranslate(analysis, 'en', 'ar');
  return arAnalysis || analysis;
}

// ─── توليد جملة مثال للكلمة ──────────────────────────────────────────────────
async function localMakeExample(word, langCode) {
  const enWord = langCode === 'ar'
    ? (await localTranslate(word, 'ar', 'en') || word)
    : word;
  const prompt = `Write one short example sentence using the word "${enWord}":`;
  const ex = await localGenerate(prompt, 80);
  if (!ex) return null;
  if (langCode === 'ar') return await localTranslate(ex, 'en', 'ar') || ex;
  return ex;
}

// ══════════════════════════════════════════════════════════════════════════════
//  🧠  Wolf BRAIN — الذاكرة الذاتية التعلّمية
//  • يجلب محتوى جديداً بالذكاء الاصطناعي المحلي في كل لعبة — لا تكرار أبداً
//  • يتعلم تلقائياً من كل لعبة ويطوّر صعوبته بناءً على أداء اللاعبين
//  • يتذكر ما تعلّمه ويوسّع مخزونه المعرفي مع كل جلسة لعب
// ══════════════════════════════════════════════════════════════════════════════
console.log('[AI] 🤖 Wolf AI + flan-t5-base + Transformers.js — التشغيل...');

// ─── ① رموز اللغات ─────────────────────────────────────────────────────────
const LANG_CODES = {
  'Arabic':'ar','English':'en','French':'fr','Spanish':'es','German':'de',
  'Turkish':'tr','Italian':'it','Portuguese':'pt','Russian':'ru','Chinese':'zh',
  'Japanese':'ja','Korean':'ko','Persian':'fa','Hindi':'hi','Dutch':'nl','Urdu':'ur',
};

// ─── ② محرك NLP — التطبيع والجذور ──────────────────────────────────────────
function normTxt(s) {
  return String(s).toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g,'')       // حذف التشكيل العربي
    .replace(/[أإآأ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي')
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g,' ')
    .replace(/\s+/g,' ').trim();
}
// تحليل جذر الكلمة العربية (مبسّط)
function arabicRoot(word) {
  const w = normTxt(word);
  return w.replace(/^(ال|وال|فال|بال|كال|لل)/,'')
          .replace(/(ات|ون|ين|ان|ه|ها|هم|هن|نا|كم|كن|ي|تي|ني|ك|ه)$/,'');
}
// كاشف اللغة بالخصائص الحرفية
function detectLang(text) {
  const arabicChars  = (text.match(/[\u0600-\u06FF]/g)||[]).length;
  const frenchChars  = (text.match(/[àâäéèêëîïôùûüÿçœæ]/gi)||[]).length;
  const latinChars   = (text.match(/[a-zA-Z]/g)||[]).length;
  if (arabicChars > latinChars) return 'Arabic';
  if (frenchChars > 2) return 'French';
  return 'English';
}

// ─── ③ خوارزميات المقارنة الذكية ───────────────────────────────────────────
function lev(a,b) {
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>j===0?i:0));
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}
function simScore(a,b) {
  const na=normTxt(a),nb=normTxt(b);
  if(!na||!nb) return 0;
  if(na===nb) return 1;
  // تطابق الجذور العربية
  if(arabicRoot(na)===arabicRoot(nb)&&arabicRoot(na).length>2) return 0.92;
  // تطابق مع حذف ال التعريف
  const sa=na.replace(/^ال/,''), sb=nb.replace(/^ال/,'');
  if(sa===sb&&sa.length>1) return 0.95;
  // تضمين: كلمة واحدة داخل الأخرى
  if(na.includes(nb)||nb.includes(na)) {
    const ratio=Math.min(na.length,nb.length)/Math.max(na.length,nb.length);
    return 0.7+ratio*0.25;
  }
  return Math.max(0, 1-lev(na,nb)/Math.max(na.length,nb.length));
}
function wordOverlap(ref,player) {
  const rw=new Set(normTxt(ref).split(' ').filter(w=>w.length>2));
  const pw=normTxt(player).split(' ').filter(w=>w.length>2);
  if(!rw.size) return 0;
  let m=0; for(const w of pw) if(rw.has(w)) m++;
  // مرونة للكلمات المشتقة
  if(m===0) {
    for(const w of pw)
      for(const r of rw)
        if(arabicRoot(w)===arabicRoot(r)&&arabicRoot(w).length>2) { m+=0.8; break; }
  }
  return Math.min(1, m/rw.size*1.2);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ BRAIN — الذاكرة الذاتية المتطورة (تحفظ في brain.json)
// ══════════════════════════════════════════════════════════════════════════
const BRAIN_FILE = path.join(__dirname, 'brain.json');
let BRAIN = {
  articles: {},
  pairs: {},
  usedByChannel: {},
  stats: { totalFetched:0, gamesPlayed:0, lastFetch:0 }
};
function loadBrain() {
  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(BRAIN_FILE,'utf8'));
      BRAIN = { ...BRAIN, ...saved };
    }
  } catch(e) { console.warn('[BRAIN] خطأ:', e.message); }
}
function saveBrain() {
  try { fs.writeFileSync(BRAIN_FILE, JSON.stringify(BRAIN)); } catch(e) {}
}
loadBrain();
console.log('[BRAIN] مقالات محفوظة:', Object.keys(BRAIN.articles).length,
            '| أزواج:', Object.keys(BRAIN.pairs).length);

// ══════════════════════════════════════════════════════════════════════════
// ④ ويكاموس (Wiktionary) API — قاموس لغوي حقيقي غني بالكلمات والتعريفات
//    نفس واجهة ويكاموس — مجاني بلا مفاتيح — يغطي العربية والإنجليزية وأكثر
// ══════════════════════════════════════════════════════════════════════════

// كلمة عشوائية من ويكاموس
async function wiktRandom(langCode) {
  const r = await fetch(
    `https://${langCode}.wiktionary.org/api/rest_v1/page/random/summary`,
    { signal: AbortSignal.timeout(12000) }
  );
  if (!r.ok) throw new Error('Wikt ' + r.status);
  return await r.json();
}

// تعريف كلمة محددة من ويكاموس
async function wiktSummary(word, langCode) {
  try {
    const r = await fetch(
      `https://${langCode}.wiktionary.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

// ترجمة كلمة عبر روابط اللغات في ويكاموس
async function wiktLangLink(word, fromCode, toCode) {
  try {
    const url = `https://${fromCode}.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(word)}&prop=langlinks&lllang=${toCode}&format=json&origin=*`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const d = await r.json();
    const pages = Object.values(d.query?.pages||{});
    return pages[0]?.langlinks?.[0]?.['*'] || null;
  } catch(e) { return null; }
}

// بحث عن كلمة في ويكاموس بالإنجليزية (أشمل للترجمات)
async function wiktSearch(word) {
  try {
    const url = `https://en.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(word)}&prop=langlinks&lllimit=20&format=json&origin=*`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return {};
    const d = await r.json();
    const pages = Object.values(d.query?.pages||{});
    const links = pages[0]?.langlinks || [];
    const result = {};
    for (const l of links) result[l.lang] = l['*'];
    return result;
  } catch(e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ محرك المحتوى الذكي — جلب + تعلم + عدم التكرار + تطوير الصعوبة تلقائياً
// ══════════════════════════════════════════════════════════════════════════
// تلميح إكمال الفراغ — يُستخدم في !كلمات و!إعراب (يخفي العنوان)
function makeClue(title, extract, description) {
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const cleaned = (extract||'')
    .replace(new RegExp(esc,'gi'),'___')
    .replace(/\s*\([^)]{0,60}\)/g,'')
    .split('.')[0].trim();
  if (cleaned.length >= 25) return cleaned;
  if ((description||'').length > 10) return description;
  return (extract||'').slice(0,200).split('.')[0].trim();
}
// تعريف نظيف — يُستخدم في !معرفات (يظهر التعريف الكامل والجواب هو الاسم)
function makeDef(title, extract, description) {
  const firstSent = (extract||'').replace(/\s*\([^)]{0,80}\)/g,'').split('.')[0].trim();
  if (firstSent.length >= 25) return firstSent;
  if ((description||'').length > 10) return description;
  return (extract||'').slice(0,250).trim();
}

function markUsed(channelId, key) {
  const cid = String(channelId);
  if (!BRAIN.usedByChannel[cid]) BRAIN.usedByChannel[cid] = [];
  if (!BRAIN.usedByChannel[cid].includes(key)) {
    BRAIN.usedByChannel[cid].push(key);
    if (BRAIN.usedByChannel[cid].length > 300)
      BRAIN.usedByChannel[cid] = BRAIN.usedByChannel[cid].slice(-150);
  }
}

function learnResult(key, wasCorrect) {
  if (!key) return;
  const a = BRAIN.articles[key] || BRAIN.pairs[key];
  if (!a) return;
  a.played = (a.played||0) + 1;
  a.correct = (a.correct||0) + (wasCorrect ? 1 : 0);
  // صعوبة متوسطة: نطاق 0.35–0.65 حتى لا تصبح الأسئلة سهلة جداً أو صعبة جداً
  a.difficulty = +(Math.max(0.35, Math.min(0.65, 1 - a.correct/a.played)).toFixed(2));
  BRAIN.stats.gamesPlayed = (BRAIN.stats.gamesPlayed||0) + 1;
  saveBrain();
}

// صفحات يجب تجاهلها في ويكاموس
const SKIP_RE = /(appendix|index|thesaurus|rhymes|concordance|category|template|help|wiktionary|user|file|module|تصنيف|قائمة|نموذج|ملف|مساعدة|ويكاموس|مستخدم)/i;

// ─── جلب كلمة عشوائية وتعريفها من ويكاموس ──────────────────────────────
async function fetchArticle(langCode, channelId) {
  const cid = String(channelId);
  const used = BRAIN.usedByChannel[cid] || [];

  // تفضيل الكلمات الأقرب للمستوى المتوسط (0.5)
  const available = Object.entries(BRAIN.articles)
    .filter(([k,v]) => v.lang===langCode && !used.includes(k))
    .sort((a,b) => Math.abs((a[1].difficulty||0.5)-0.5) - Math.abs((b[1].difficulty||0.5)-0.5));

  if (available.length > 0) {
    const pool = available.slice(0, Math.min(8, available.length));
    const [key, art] = pool[Math.floor(Math.random()*pool.length)];
    markUsed(cid, key);
    saveBrain();
    return { ...art, key };
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const d = await wiktRandom(langCode);
      if (!d?.title) continue;
      // تجاهل صفحات المساعدة والتصنيفات
      if (SKIP_RE.test(d.title) || d.title.includes(':')) continue;
      // تجاهل الكلمات القصيرة جداً أو الطويلة جداً (غالباً ليست كلمات)
      if (d.title.length < 2 || d.title.length > 35) continue;
      // تجاهل إذا كان التعريف فارغاً
      const extract = (d.extract||'').trim();
      if (extract.length < 15) continue;

      const key = langCode + ':' + d.title;
      if (BRAIN.articles[key]) { markUsed(cid, key); saveBrain(); return { ...BRAIN.articles[key], key }; }

      // التعريف من ويكاموس مباشرةً (هو قاموس بطبيعته)
      const def = makeDef(d.title, extract, d.description||'');
      const clue = makeClue(d.title, extract, d.description||'');

      const art = { title:d.title, clue, def, lang:langCode, difficulty:0.5, played:0, correct:0 };
      BRAIN.articles[key] = art;
      BRAIN.stats.totalFetched = (BRAIN.stats.totalFetched||0)+1;
      BRAIN.stats.lastFetch = Date.now();
      markUsed(cid, key);
      saveBrain();
      console.log('[WIKT] تعلّمت:', d.title, '('+langCode+') ←', def.slice(0,40));
      return { ...art, key };
    } catch(e) {
      console.warn('[WIKT]', e.message?.slice(0,50));
      await new Promise(r=>setTimeout(r,1500));
    }
  }
  return null;
}

// ─── جلب زوج ترجمة — AI محلي للترجمة + ويكاموس للكلمة العشوائية ────────
async function fetchTranslationPair(fromCode, toCode, channelId) {
  const cid = String(channelId);
  const used = BRAIN.usedByChannel[cid] || [];

  // من الذاكرة أولاً
  const available = Object.entries(BRAIN.pairs)
    .filter(([k,v]) => v[fromCode] && v[toCode] && !used.includes(k))
    .sort((a,b) => Math.abs((a[1].difficulty||0.5)-0.5) - Math.abs((b[1].difficulty||0.5)-0.5));
  if (available.length > 0) {
    const [key, pair] = available[Math.floor(Math.random()*Math.min(8,available.length))];
    markUsed(cid, key); saveBrain();
    return { src: pair[fromCode], ans: pair[toCode], key };
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const d = await wiktRandom(fromCode);
      if (!d?.title || d.title.includes(':') || d.title.length > 30) continue;
      if (SKIP_RE.test(d.title)) continue;

      // ① ترجمة بالـ AI المحلي (أفضل وأسرع)
      let translated = await localTranslate(d.title, fromCode, toCode);

      // ② احتياط: ويكاموس
      if (!translated) translated = await wiktLangLink(d.title, fromCode, toCode);
      if (!translated || translated === d.title) continue;

      const key = 'pair:' + fromCode + ':' + d.title;
      BRAIN.pairs[key] = { [fromCode]:d.title, [toCode]:translated, played:0, correct:0 };
      markUsed(cid, key); saveBrain();
      console.log('[AI-PAIR] ✅', d.title, '→', translated);
      return { src: d.title, ans: translated, key };
    } catch(e) {
      console.warn('[AI-PAIR]', e.message?.slice(0,50));
      await new Promise(r=>setTimeout(r,1500));
    }
  }
  return null;
}

// ─── جلب جملة ثنائية — تعريف + ترجمته بالـ AI المحلي ───────────────────
async function fetchBilingualSentence(fromCode, toCode, channelId) {
  const cid = String(channelId);
  const used = BRAIN.usedByChannel[cid] || [];

  // من الذاكرة أولاً
  const available = Object.entries(BRAIN.pairs)
    .filter(([k,v]) => k.startsWith('sent:') && v[fromCode] && v[toCode] && !used.includes(k));
  if (available.length > 0) {
    const [key, pair] = available[Math.floor(Math.random()*Math.min(8,available.length))];
    markUsed(cid, key); saveBrain();
    return { src: pair[fromCode], ans: pair[toCode], key };
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const d = await wiktRandom(fromCode);
      if (!d?.title || SKIP_RE.test(d.title) || d.title.includes(':')) continue;
      const defFrom = (d.extract||'').split('.')[0].trim();
      if (defFrom.length < 20) continue;

      // ① ترجمة التعريف كاملاً بالـ AI المحلي
      let defTo = await localTranslate(defFrom, fromCode, toCode);

      // ② احتياط: ابحث عن التعريف في ويكاموس باللغة الهدف
      if (!defTo) {
        const linked = await wiktLangLink(d.title, fromCode, toCode);
        if (linked) {
          const d2 = await wiktSummary(linked, toCode);
          defTo = d2?.extract?.split('.')[0].trim() || null;
        }
      }
      if (!defTo || defTo.length < 10) continue;

      const key = 'sent:' + fromCode + ':' + d.title;
      BRAIN.pairs[key] = { [fromCode]:defFrom, [toCode]:defTo, played:0, correct:0 };
      markUsed(cid, key); saveBrain();
      console.log('[AI-SENT] ✅', defFrom.slice(0,30), '→', defTo.slice(0,30));
      return { src: defFrom, ans: defTo, key };
    } catch(e) {
      console.warn('[AI-SENT]', e.message?.slice(0,50));
      await new Promise(r=>setTimeout(r,1500));
    }
  }
  return null;
}

// ─── معنى كلمة — النموذج المحلي أولاً، ثم Free Dictionary احتياطاً ──────────
//  ① flan-t5-base (محلي، بدون إنترنت، يفهم التعليمات)
//  ② Free Dictionary API (إنجليزي — احتياط سريع)
//  ③ DuckDuckGo (آخر احتياط)
async function aiMeaning(word, langCode) {
  const results = [];

  // ① النموذج اللغوي المحلي flan-t5-base — يعمل بدون أي API خارجي
  const localDef = await localWordMeaning(word, langCode);
  if (localDef && localDef.length > 10) {
    console.log('[LOCAL-MEAN] ✅', word, ':', localDef.slice(0,50));
    return localDef;
  }

  // ② Free Dictionary API — احتياط للإنجليزي (مجاني، بلا مفاتيح)
  if (langCode === 'en' || /^[a-zA-Z\s'-]+$/.test(word.trim())) {
    try {
      const r = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim())}`,
        { signal: AbortSignal.timeout(7000) }
      );
      if (r.ok) {
        const data = await r.json();
        // جملة واحدة فقط — أول تعريف من أول نوع كلام
        const firstMeaning = data?.[0]?.meanings?.[0];
        const firstDef     = firstMeaning?.definitions?.[0]?.definition || '';
        const pos          = firstMeaning?.partOfSpeech || '';
        if (firstDef.length > 5) {
          const short = `(${pos}) ${firstDef}`.slice(0, 200);
          console.log('[DICT-API] ✅', word, ':', short.slice(0,50));
          results.push(short);
        }
      }
    } catch(e) { console.warn('[DICT-API]', e.message?.slice(0,40)); }
    if (results.length > 0) return results[0];
  }

  // ② DuckDuckGo — بحث حر للكلمة
  try {
    const query = langCode === 'ar'
      ? `${word} معنى تعريف`
      : `${word} definition meaning`;
    const ddg = await duckSearch(query);
    const text = ddg.abstract || ddg.definition || ddg.answer || '';
    if (text.length > 20) {
      console.log('[DDG-MEAN] ✅', word, ':', text.slice(0,50));
      return text.slice(0, 400);
    }
    // جرّب الموضوعات المرتبطة
    if (ddg.topics.length > 0) {
      const best = ddg.topics.find(t => t.length > 30) || ddg.topics[0];
      if (best) return best.slice(0, 300);
    }
  } catch(e) { console.warn('[DDG-MEAN]', e.message?.slice(0,40)); }

  // ③ ويكيبيديا (عربية أو إنجليزية)
  try {
    const wiki = langCode === 'ar' ? 'ar' : 'en';
    const url  = `https://${wiki}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
    const r    = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (r.ok) {
      const d = await r.json();
      if (d?.extract && d.extract.length > 20) {
        console.log('[WIKI-MEAN] ✅', word);
        return d.extract.split('.').slice(0,2).join('.').trim() + '.';
      }
    }
  } catch(e) { console.warn('[WIKI-MEAN]', e.message?.slice(0,40)); }

  // ④ بحث ويكيبيديا عبر API إذا لم يوجد مقال مباشر
  try {
    const wiki  = langCode === 'ar' ? 'ar' : 'en';
    const qTerm = langCode === 'ar' ? `${word} معنى` : `${word} definition`;
    const url   = `https://${wiki}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(qTerm)}&srlimit=1&format=json&origin=*`;
    const r     = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (r.ok) {
      const d = await r.json();
      const title = d?.query?.search?.[0]?.title;
      if (title) {
        const r2 = await fetch(
          `https://${wiki}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
          { signal: AbortSignal.timeout(7000) }
        );
        if (r2.ok) {
          const d2 = await r2.json();
          if (d2?.extract && d2.extract.length > 20) {
            return d2.extract.split('.').slice(0,2).join('.').trim() + '.';
          }
        }
      }
    }
  } catch(e) { console.warn('[WIKI-SEARCH]', e.message?.slice(0,40)); }

  return null;
}

// ─── ترجمة كلمة — AI محلي أولاً ثم ويكاموس احتياط ──────────────────────
async function aiTranslate(word, fromCode, toCode) {
  // ① النموذج المحلي (دقيق، سريع، بدون إنترنت)
  const aiResult = await localTranslate(word, fromCode, toCode);
  if (aiResult && aiResult !== word) return aiResult;
  // ② ويكاموس احتياط (لأزواج اللغات غير المدعومة بنموذج محلي)
  const linked = await wiktLangLink(word, fromCode, toCode);
  if (linked) return linked;
  const all = await wiktSearch(word);
  return all[toCode] || null;
}

function aiHint(game) {
  const ans = game?.answer || '';
  if (ans.length <= 3) return `💡 الإجابة تبدأ بـ "${ans[0]||''}"`;
  return `💡 الإجابة من ${ans.length} حرف وتبدأ بـ "${ans[0]}"`;
}



// ─── قاعدة البيانات ───────────────────────────────────────────────────────────
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
// اللاعبون الحقيقيون عالمياً (لديهم نقاط)
function realPlayers() {
  return Object.values(db.players).filter(p => (p.pts||0) > 0).sort((a,b) => b.pts - a.pts);
}
// اللاعبون الحقيقيون في قناة محددة فقط
function realPlayersInChannel(cid) {
  const c = String(cid);
  return Object.values(db.players)
    .filter(p => (p.pts||0) > 0 && Array.isArray(p.channels) && p.channels.includes(c))
    .sort((a,b) => b.pts - a.pts);
}

// ─── حالة الألعاب ──────────────────────────────────────────────────────────────
const games    = {};  // cid → {type,lang,fromLang,toLang,question,answer,display,timer}
const autoSt   = {};  // cid → {active,type,lang,fromLang,toLang}
const pregenQ  = {};  // cid → {type,...question}
const busy     = {};  // cid → bool
const lastAns  = {};  // `${cid}_${uid}` → timestamp

// ─── فلتر المحتوى الإباحي ─────────────────────────────────────────────────────
const VULGAR_RE = /زب|كس|طيز|شرم|عاهر|ق[حض]ب[هة]|منيو[كك]|متناك|ينيك|بتناك|نيك|شراميط|عرص|لوطي|خول|فاجر[هة]?|داعر[هة]?|فاحش[هة]?|porn|sex(?:ual|y)?|fuck|shit|bitch|cock|pussy|ass(?:hole)?|dick|nude|naked|xxx/i;

function isVulgar(text) {
  return VULGAR_RE.test(text);
}

// ─── الكشف السريع عن الأوامر العربية (بدون AI) ───────────────────────────────
// يُغطّي الأوامر الأكثر شيوعاً لتوفير وقت Gemini
function fastDetect(text) {
  const t = text.trim();
  const tl = t.toLowerCase().replace(/\s+/g,' ');

  // مساعدة — فقط الأمر المحدد !لغه مساعده
  if (/^[!！](لغه|لغة)\s*(مساعده|مساعدة)$/.test(tl)) return {cmd:'HELP',userLang:'Arabic'};
  // نقاط
  if (/^[!！](لغه|لغة)\s*(مجموع|نقاطي)/.test(tl)) return {cmd:'MY_SCORE',userLang:'Arabic'};
  // ترتيب
  if (/^[!！](لغه|لغة)\s*ترتيب\s*قنا/.test(tl)) return {cmd:'RANK_CHANNEL',userLang:'Arabic'};
  if (/^[!！](لغه|لغة)\s*ترتيب\s*(ولف|wolf)/.test(tl)) return {cmd:'RANK_GLOBAL',userLang:'Arabic'};
  // التالي
  if (/^[!！](لغه|لغة)\s*(التالي|تالي)/.test(tl)) return {cmd:'NEXT',userLang:'Arabic'};

  // الأوضاع التلقائية الخمسة
  if (/^[!！]معرفات\s*تلقائي/.test(tl)) return {cmd:'AUTO_GAME_GUESS',userLang:'Arabic'};
  if (/^[!！]معاني\s*تلقائي/.test(tl))  return {cmd:'AUTO_GAME_WORD',userLang:'Arabic'};
  // تلقائي مع أزواج لغات: !كلمه عربي فرنسي تلقائي
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
  if (/^[!！]كلم[هة]\s*تلقائي/.test(tl))         return {cmd:'AUTO_GAME_TR_WORD',userLang:'Arabic'};
  if (/^[!！]جمل[هة]\s*تلقائي/.test(tl))         return {cmd:'AUTO_GAME_TR_SENT',userLang:'Arabic'};
  if (/^[!！]نص\s*تلقائي/.test(tl))               return {cmd:'AUTO_GAME_TR_TEXT',userLang:'Arabic'};
  if (/^[!！](اعرب|إعراب)\s*تلقائي/.test(tl))    return {cmd:'AUTO_GAME_GRAMMAR',userLang:'Arabic'};

  // بدء الألعاب — !كلمه بدء (بدون معاملات لغة) يجب أن يكون قبل كشف ترجمة الكلمات
  if (/^[!！]معرفات\s*بدء$/.test(tl)) { console.log('[FAST] GAME_GUESS'); return {cmd:'GAME_GUESS',  userLang:'Arabic'}; }
  if (/^[!！]معاني\s*بدء/.test(tl))    { console.log('[FAST] GAME_WORD');  return {cmd:'GAME_WORD',   userLang:'Arabic'}; }
  if (/^[!！](اعرب|إعراب)\s*بدء$/.test(tl)) { console.log('[FAST] GAME_GRAMMAR'); return {cmd:'GAME_GRAMMAR',userLang:'Arabic'}; }

  // بدء ألعاب الترجمة بمعامل لغوي: !كلمه {من} {الى} بدء  /  !جمله  /  !نص
  {
    const LANG_MAP = {
      'عربي':'Arabic','عربية':'Arabic',
      'انجليزي':'English','انجليزية':'English','انكليزي':'English','إنجليزي':'English',
      'فرنسي':'French','فرنسية':'French',
      'تركي':'Turkish','تركية':'Turkish',
      'الماني':'German','المانية':'German','ألماني':'German',
      'اسباني':'Spanish','اسبانية':'Spanish','إسباني':'Spanish',
      'ايطالي':'Italian','ايطالية':'Italian','إيطالي':'Italian',
      'فارسي':'Persian','فارسية':'Persian',
      'اردو':'Urdu','أردو':'Urdu',
      'هندي':'Hindi','صيني':'Chinese','روسي':'Russian',
      'ياباني':'Japanese','كوري':'Korean',
      'برتغالي':'Portuguese','هولندي':'Dutch',
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

  // معنى كلمة
  if (/^[!！]معن[ىي]\s+\S/.test(tl)) {
    const m = t.match(/^[!！]\S+\s+(.+)/);
    return {cmd:'MEANING', userLang:'Arabic', queryText: m?m[1].trim():''};
  }

  // !بحث — بحث حر في الإنترنت
  if (/^[!！]بحث\s+\S/.test(tl)) {
    const m = t.match(/^[!！]\S+\s+(.+)/);
    return {cmd:'SEARCH', userLang:'Arabic', queryText: m?m[1].trim():''};
  }

  // ترجمة: !ترجمه {لغة} {نص}
  if (/^[!！]ترجم[هة]?\s+\S/.test(tl)) {
    const parts = t.replace(/^[!！]\S+\s+/, '').trim().split(/\s+/);
    const langWord = parts[0] || '';
    const queryText = parts.slice(1).join(' ');
    const langMap = {
      'انجليزي':'English','انجليزية':'English','انكليزي':'English',
      'عربي':'Arabic','عربية':'Arabic',
      'فرنسي':'French','فرنسية':'French',
      'تركي':'Turkish','تركية':'Turkish',
      'الماني':'German','المانية':'German',
      'اسباني':'Spanish','اسبانية':'Spanish',
      'ايطالي':'Italian','ايطالية':'Italian',
      'فارسي':'Persian','فارسية':'Persian',
      'اردو':'Urdu','هندي':'Hindi',
      'صيني':'Chinese','روسي':'Russian',
      'ياباني':'Japanese','كوري':'Korean',
      'برتغالي':'Portuguese','هولندي':'Dutch',
    };
    const toLang = langMap[langWord] || langWord || 'English';
    return {cmd:'TRANSLATE', userLang:'Arabic', fromLang:'Arabic', toLang, queryText};
  }

  return null;
}

// ─── قائمة سوداء للبوتات الأخرى (أوائل أوامرها) ─────────────────────────────
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

// ─── كشف الأوامر بالأنماط (بدون AI) ─────────────────────────────────────────
async function detectIntent(text) {
  if (isOtherBotCmd(text)) return {cmd:'UNKNOWN',userLang:'Arabic'};
  // fastDetect يغطي معظم الحالات — هنا فقط اللغات الأخرى
  const tl = text.trim().toLowerCase();
  // MEANING بالإنجليزية أو غيرها
  const mMean = text.match(/^[!！]\s*(?:meaning|define|definition|means?)\s+(.+)/i);
  if (mMean) return {cmd:'MEANING',userLang:'English',queryText:mMean[1].trim()};
  // TRANSLATE بالإنجليزية: !translate {lang} {text}
  const mTr = text.match(/^[!！]\s*(?:translate?|tr)\s+(\S+)\s+(.+)/i);
  if (mTr) {
    const toLang = {
      arabic:'Arabic',english:'English',french:'French',spanish:'Spanish',
      german:'German',turkish:'Turkish',italian:'Italian',russian:'Russian',
    }[mTr[1].toLowerCase()] || mTr[1];
    return {cmd:'TRANSLATE',userLang:'English',toLang,queryText:mTr[2].trim()};
  }
  return {cmd:'UNKNOWN',userLang:'Arabic'};
}

// ─── تقييم الإجابات — AI دلالي + Fuzzy Matching احتياط ─────────────────────
const FB_OK  = ['ممتاز! ✨','أحسنت! 🌟','رائع! 🎉','صحيح تماماً! ✅','عمل رائع! 👏'];
const FB_BAD = ['غير صحيح ❌','حاول مرة أخرى 💪','للأسف خطأ ❌','راجع الإجابة 🔄'];

async function evalAnswer(game, playerMsg) {
  if (game.type === 'GAME_GRAMMAR') return evalGrammar(game, playerMsg);

  const maxPts = game.type === 'GAME_TR_TEXT' ? 30 : 10;
  let pct = 0;

  if (game.type === 'GAME_GUESS' || game.type === 'GAME_TR_WORD') {
    // ① تقييم AI دلالي — يفهم المرادفات والتصريفات
    const aiPct = await aiScore(game.answer, playerMsg);
    if (aiPct !== null) {
      pct = aiPct;
    } else {
      // ② احتياط: مقارنة حرفية
      pct = Math.round(simScore(game.answer, playerMsg) * 100);
    }
  } else if (game.type === 'GAME_WORD') {
    // اللاعب يشرح المعنى — AI يقيّم التشابه الدلالي
    const aiPct = await aiScore(game.answer, playerMsg);
    if (aiPct !== null) {
      pct = Math.max(aiPct, playerMsg.trim().length > 10 ? 25 : 0);
    } else {
      pct = Math.round(Math.min(1, wordOverlap(game.answer, playerMsg)) * 100);
      if (playerMsg.trim().length > 5) pct = Math.max(pct, 30);
    }
  } else {
    // ترجمة جمل — AI يقيّم التشابه الدلالي للجملة كاملة
    const aiPct = await aiScore(game.answer, playerMsg);
    if (aiPct !== null) {
      pct = Math.min(aiPct, 95);
    } else {
      pct = Math.min(Math.round(Math.min(1, wordOverlap(game.answer, playerMsg)) * 100), 95);
    }
  }

  const ok  = pct >= 50;
  const pts = Math.min(Math.round(pct / 100 * maxPts), maxPts);
  const feedback = ok ? pick(FB_OK) : pick(FB_BAD);
  console.log(`[EVAL-AI] type=${game.type} pct=${pct} pts=${pts} ok=${ok}`);
  return { correct: ok || pct >= 40, pct, pts, difficulty:2, diffLabel:'', feedback };
}

async function evalGrammar(game, playerMsg) {
  const terms = ['فعل','فاعل','مفعول','مبتدأ','خبر','نعت','مجرور','منصوب','مرفوع','حرف','اسم','مضاف','ماضٍ','مضارع','أمر','جازم','ناصب','رافع','تابع','صفة'];
  const pw = normTxt(playerMsg).split(' ');
  const matched = terms.filter(t => pw.some(w => w.includes(t))).length;
  // AI يقيّم جودة الإجابة النحوية دلالياً
  const aiPct  = await aiScore(game.answer, playerMsg);
  const termPct = Math.min(95, matched * 12 + wordOverlap(game.answer, playerMsg) * 40);
  const pct = aiPct !== null
    ? Math.round((aiPct * 0.4 + termPct * 0.6))
    : Math.max(35, Math.round(termPct));
  const pts = Math.min(Math.round(pct / 100 * 10), 10);

  // النموذج المحلي يولّد ملاحظة نحوية مخصصة
  let feedback;
  if (pct >= 60) {
    feedback = pick(['تحليل جيد! 📝','أحسنت في الإعراب! ✅','ممتاز! 🌟']);
  } else {
    // محاولة توليد تلميح نحوي من النموذج المحلي (فقط لو جاهز)
    try {
      const hint = await localGenerate(
        `Give a very short grammar tip (1 sentence) for: "${game.question?.slice(0,60)}"`,
        40, true  // requireLoaded — لا تنتظر تحميل النموذج
      );
      if (hint && /[\u0600-\u06FF]/.test(hint)) {
        feedback = `💡 ${hint.slice(0,100)}`;
      } else {
        const arHint = hint ? await localTranslate(hint, 'en', 'ar') : null;
        feedback = arHint ? `💡 ${arHint.slice(0,100)}` : pick(['أضف مصطلحات الإعراب 💪','راجع علامات الإعراب 📖']);
      }
    } catch(e) {
      feedback = pick(['أضف مصطلحات الإعراب 💪','راجع علامات الإعراب 📖','حاول بمصطلحات نحوية ✍️']);
    }
  }
  return { correct: pct >= 40, pct: Math.round(pct), pts, difficulty:2, diffLabel:'', feedback };
}

function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

// ─── قاموس احتياطي مدمج — يُستخدم عند فشل ويكاموس والإنترنت ─────────────────
const FALLBACK_WORDS = {
  ar: [
    { title:'شمس',   def:'النجم الذي تدور حوله الأرض وتُضيء منه النهار' },
    { title:'كتاب',  def:'وعاء المعرفة المكوّن من صفحات مكتوبة أو مطبوعة' },
    { title:'ماء',   def:'سائل شفاف لا لون له ولا رائحة ولا طعم، أساس الحياة' },
    { title:'نهر',   def:'مجرى طبيعي من المياه العذبة يصبّ في البحر أو البحيرة' },
    { title:'جبل',   def:'ارتفاع طبيعي ضخم من الصخور يعلو فوق ما حوله' },
    { title:'سماء',  def:'الفضاء الذي نراه فوقنا أزرق نهاراً ومليء بالنجوم ليلاً' },
    { title:'قمر',   def:'جرم سماوي يدور حول الأرض ويعكس ضوء الشمس ليلاً' },
    { title:'بحر',   def:'مسطح مائي واسع مالح يغطي معظم سطح الكرة الأرضية' },
    { title:'شجرة',  def:'نبات خشبي كبير له جذع وأغصان وأوراق' },
    { title:'علم',   def:'المعرفة المنظمة المستندة إلى الملاحظة والتجربة والبرهان' },
    { title:'لغة',   def:'نظام تواصل بشري يُعبَّر به عن الأفكار بالكلمات والرموز' },
    { title:'تاريخ', def:'علم يدرس أحداث الماضي وتسلسلها الزمني وأسبابها ونتائجها' },
    { title:'موسيقى',def:'فن ترتيب الأصوات والإيقاعات لإنتاج تجربة جمالية' },
    { title:'رياضة', def:'نشاط بدني منظم يُمارَس للترفيه أو المنافسة أو الصحة' },
    { title:'ذاكرة', def:'قدرة العقل على تخزين المعلومات واسترجاعها عند الحاجة' },
  ],
  en: [
    { title:'ocean',    def:'A vast body of salt water covering most of the Earth\'s surface' },
    { title:'gravity',  def:'The force that attracts objects toward the center of the Earth' },
    { title:'language', def:'A system of communication using words and grammar shared by a community' },
    { title:'memory',   def:'The ability of the mind to store and recall past experiences' },
    { title:'library',  def:'A place where books and other materials are kept for people to read' },
    { title:'democracy',def:'A system of government where citizens vote to choose their leaders' },
    { title:'economy',  def:'The system of production, trade, and money in a country' },
    { title:'metaphor', def:'A figure of speech that describes something by saying it is something else' },
    { title:'algorithm',def:'A set of step-by-step instructions for solving a problem or completing a task' },
    { title:'philosophy',def:'The study of fundamental questions about existence, knowledge, and ethics' },
  ],
};

function getFallbackWord(langCode, usedTitles = []) {
  const words = FALLBACK_WORDS[langCode] || FALLBACK_WORDS.en;
  const avail  = words.filter(w => !usedTitles.includes(w.title));
  const pool   = avail.length > 0 ? avail : words; // إعادة التدوير
  return pool[Math.floor(Math.random() * pool.length)];
}

async function makeQ(type, lang, fromLang, toLang, channelId) {
  const gl = lang||fromLang||'Arabic';
  const fl = fromLang||gl;
  const tl = toLang||'English';
  const flCode = LANG_CODES[fl]||'ar';
  const tlCode = LANG_CODES[tl]||'en';
  const cid = String(channelId||'default');

  // ── معرفات: تعريف مولَّد بالذكاء الاصطناعي — مختلف في كل مرة ────────────
  if (type==='GAME_GUESS') {
    const langCode = gl==='Arabic' ? 'ar' : flCode;

    // جلب مقال (ويكاموس) أو استخدام الاحتياط المدمج
    let art = await fetchArticle(langCode, cid).catch(() => null);
    if (!art) {
      // الاحتياط المدمج — يعمل دائماً بدون إنترنت
      const fw = getFallbackWord(langCode, BRAIN.usedByChannel[cid] || []);
      art = { title: fw.title, def: fw.def, clue: fw.def, key: `fallback:${fw.title}` };
      console.log('[FALLBACK] استخدام كلمة احتياطية:', fw.title);
    }

    // ① النموذج المحلي flan-t5 يولّد تعريفاً جديداً (فقط لو جاهز)
    try {
      const aiDef = await localMakeDefinition(art.title, langCode);
      if (aiDef && aiDef.length > 15) {
        console.log('[AI-DEF] 🤖 توليد محلي:', art.title, ':', aiDef.slice(0,50));
        return { question:art.title, answer:art.title, display:aiDef, brainKey:art.key };
      }
    } catch(e) { /* يكمل للاحتياط */ }

    // ② احتياط: التعريف المخزون
    const display = art.def || makeDef(art.title, art.clue, '');
    return { question:art.title, answer:art.title, display, brainKey:art.key };
  }

  // ── شرح الكلمة: النموذج المحلي يولّد معنى مختلفاً في كل مرة ─────────────
  if (type==='GAME_WORD') {
    const langCode = gl==='Arabic' ? 'ar' : flCode;
    const art = await fetchArticle(langCode, cid);
    if (!art) throw new Error('تعذّر الحصول على كلمة');
    // النموذج المحلي يولّد تلميح المعنى (بدون ذكر الكلمة)
    try {
      const aiClue = await localMakeDefinition(art.title, langCode);
      if (aiClue && aiClue.length > 15) {
        console.log('[AI-WORD] 🤖', art.title);
        return { question:aiClue, answer:art.title, display:aiClue, brainKey:art.key };
      }
    } catch(e) { /* احتياط */ }
    return { question:art.clue, answer:art.title, display:art.clue, brainKey:art.key };
  }

  // ── ترجمة كلمة عبر ويكاموس ────────────────────────────────────────────
  if (type==='GAME_TR_WORD') {
    const pair = await fetchTranslationPair(flCode, tlCode, cid);
    if (!pair) throw new Error('تعذّر الحصول على زوج ترجمة');
    return { question:pair.src, answer:pair.ans, display:pair.src, brainKey:pair.key };
  }

  // ── ترجمة جملة عبر ويكاموس ────────────────────────────────────────────
  if (type==='GAME_TR_SENT') {
    const pair = await fetchBilingualSentence(flCode, tlCode, cid);
    if (!pair) throw new Error('تعذّر الحصول على جملة');
    return { question:pair.src, answer:pair.ans, display:pair.src, brainKey:pair.key };
  }

  // ── ترجمة نص عبر ويكاموس ──────────────────────────────────────────────
  if (type==='GAME_TR_TEXT') {
    const pair = await fetchBilingualSentence(flCode, tlCode, cid);
    if (!pair) throw new Error('تعذّر الحصول على نص');
    return { question:pair.src, answer:pair.ans, display:pair.src, brainKey:pair.key };
  }

  // ── إعراب: جملة عربية حقيقية من الإنترنت — جديدة في كل مرة ─────────────
  if (type==='GAME_GRAMMAR') {
    // ① ويكيبيديا العربية: جملة حقيقية عشوائية (80% من الوقت)
    if (Math.random() < 0.8) {
      try {
        const sent = await fetchArabicSentence();
        if (sent && sent.length >= 20 && sent.length <= 200) {
          // بحث DuckDuckGo لمعرفة موضوع الجملة (للإجابة النموذجية)
          const shortSent = sent.slice(0, 60);
          console.log('[GRAMMAR] 🆕 جملة من ويكيبيديا:', shortSent);
          return {
            question: sent,
            answer:   sent,            // الجواب: إعراب الجملة كاملاً
            display:  sent,
            brainKey: `gr_${Date.now()}_${Math.random().toString(36).slice(2,6)}`
          };
        }
      } catch(e) { console.warn('[GRAMMAR-WIKI]', e.message?.slice(0,40)); }
    }
    // ② ويكاموس احتياط
    const pair = await fetchBilingualSentence('ar', 'en', cid);
    if (pair) return { question:pair.src, answer:pair.ans, display:pair.src, brainKey:pair.key };
    const art = await fetchArticle('ar', cid);
    if (!art) throw new Error('تعذّر الحصول على جملة للإعراب');
    return { question:art.clue, answer:art.title, display:art.clue, brainKey:art.key };
  }

  throw new Error('Unknown type: '+type);
}

const LABEL = {
  GAME_GUESS:'🔍 خمّن الكلمة:', GAME_WORD:'📖 اشرح معنى:',
  GAME_TR_WORD:'🌐 ترجم:', GAME_TR_SENT:'📝 ترجم الجملة:',
  GAME_TR_TEXT:'📄 ترجم النص:', GAME_GRAMMAR:'✏️ أعرب:',
};

// ─── I/O ──────────────────────────────────────────────────────────────────────
function io(cid) {
  const send  = t => client.messaging.sendChannelMessage(cid,t,{formatting:{me:true}}).catch(()=>{});
  const alert = t => client.messaging.sendChannelMessage(cid,t,{formatting:{alert:true}}).catch(()=>{});
  return {send,alert};
}

const GAME_IDLE_MS = 5 * 60 * 1000; // 5 دقائق بدون إجابة → توقف اللعبة/الوضع التلقائي

// ─── إنهاء اللعبة الحالية ────────────────────────────────────────────────────
function endGame(cid) {
  if (games[cid]?.idleTimer) clearTimeout(games[cid].idleTimer);
  delete games[cid];
  delete pregenQ[cid];
}

// ─── إعادة ضبط مؤقت الخمول ───────────────────────────────────────────────────
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
function endAuto(cid) {
  delete autoSt[cid];
}

// ─── تشغيل لعبة ──────────────────────────────────────────────────────────────
async function startGame(cid, type, lang, fromLang, toLang) {
  console.log(`[START GAME] type=${type} lang=${lang} fl=${fromLang} tl=${toLang}`);
  endGame(cid);
  const {send,alert} = io(cid);
  await send('⏳...');
  let q;
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pre = pregenQ[cid];
      if (attempt === 1 && pre?.type===type) { q=pre; delete pregenQ[cid]; break; }
      q = await makeQ(type, lang, fromLang, toLang, cid);
      break;
    } catch(e) {
      lastErr = e.message || String(e);
      console.error(`[MAKEQ ERR attempt=${attempt}]`, type, lastErr.slice(0,120));
      if (attempt === 3) {
        await alert('⚠️ تعذّر توليد السؤال. تحقق من الاتصال بالإنترنت وحاول لاحقاً.');
        return;
      }
      await sleep(3000);
    }
  }
  if (!q) return;
  games[cid] = {type,lang,fromLang,toLang,...q};
  resetIdleTimer(cid);
  // تحضير السؤال التالي في الخلفية (التعلم الاستباقي)
  makeQ(type,lang,fromLang,toLang,cid).then(nq=>{ pregenQ[cid]={type,...nq}; }).catch(()=>{});
  const arrow = ['GAME_TR_WORD','GAME_TR_SENT','GAME_TR_TEXT'].includes(type) ? ` (${fromLang}→${toLang})` : '';
  await send(`${LABEL[type]||'🎮'}${arrow}\n\n${q.display}\n\n💡 اكتب # قبل إجابتك`);
}

// ─── الوضع التلقائي ───────────────────────────────────────────────────────────
// لا يوجد مؤقت تلقائي — الانتقال للسؤال التالي فقط عند الإجابة الصحيحة أو !لغه التالي

async function toggleAuto(cid, type, lang, fromLang, toLang) {
  const {send} = io(cid);
  if (autoSt[cid]?.active && autoSt[cid]?.type===type) {
    // إيقاف
    endAuto(cid);
    endGame(cid);
    await send('❌ الوضع التلقائي أُوقف');
  } else {
    // تشغيل
    endAuto(cid);
    autoSt[cid] = {active:true,type,lang,fromLang,toLang};
    await send('✅ الوضع التلقائي مفعّل 🔄\n💡 السؤال التالي يأتي فقط بعد الإجابة الصحيحة أو !لغه التالي');
    await startGame(cid, type, lang, fromLang, toLang);
  }
}

// ─── قائمة المساعدة ───────────────────────────────────────────────────────────
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
🔍 !بحث [كلمة] — بحث في الإنترنت (DuckDuckGo)
📋 !لغه مساعده`;

// ─── Wolf Bot ─────────────────────────────────────────────────────────────────
const client = new WOLF();

// ─── نظام إعادة الاتصال التلقائي ─────────────────────────────────────────────
let _connected   = false;
let _reconnDelay = 5000; // يبدأ بـ 5 ثوانٍ، يتضاعف حتى 60 ثانية
const MAX_DELAY  = 60000;

function scheduleReconnect(reason) {
  console.warn(`[RECONNECT] ${reason} — محاولة بعد ${_reconnDelay/1000}s`);
  setTimeout(() => {
    client.login(BOT_EMAIL, BOT_PASS).catch(e => {
      console.error('[LOGIN ERR]', e.message);
    });
  }, _reconnDelay);
  _reconnDelay = Math.min(_reconnDelay * 2, MAX_DELAY);
}

client.on('ready', () => {
  console.log('[BOT] ✅ متصل!');
  _connected   = true;
  _reconnDelay = 5000; // إعادة ضبط التأخير عند نجاح الاتصال
});
client.on('loginFailed', r  => { _connected = false; scheduleReconnect(`loginFailed: ${r}`); });
client.on('disconnected', r => { _connected = false; scheduleReconnect(`disconnected: ${r}`); });

// ─── Watchdog — كل دقيقتين للتحقق من الاتصال ──────────────────────────────
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

  // تجاهل إذا لا توجد لعبة ولا يبدأ بـ ! أو #
  if (!hasGame && !isCmd) return;
  if (hasGame && !isCmd && !isAns) return;

  const {send,alert} = io(cid);

  // ─── تقييم الإجابة (رسائل تبدأ بـ # في قناة فيها لعبة) ─────────────────
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
      const brainKey = games[cid]?.brainKey || null;
      if (ev.correct || ev.pct>=30) {
        // ─── الذكاء الاصطناعي يتعلم: الإجابة الصحيحة تقلل صعوبة السؤال ──
        learnResult(brainKey, true);
        // ─── تسجيل اللاعب فقط عند الحصول على نقاط ───────────────────────
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
        // ─── الذكاء الاصطناعي يتعلم: الإجابة الخاطئة ترفع صعوبة السؤال ──
        learnResult(brainKey, false);
        const bar = '█'.repeat(Math.round(ev.pct/10)) + '░'.repeat(10-Math.round(ev.pct/10));
        await alert(`❌ ${ev.pct}%${diff}\n${bar}\n💬 ${ev.feedback}`);
      }
    } finally { clearTimeout(busyGuard); busy[cid]=false; }
    return;
  }

  // ─── كشف الأمر ─────────────────────────────────────────────────────────
  if (!isCmd) return;
  const intent = fastDetect(text) || await detectIntent(text);
  if (!intent || intent.cmd==='UNKNOWN') return;

  const {cmd,userLang,fromLang,toLang,queryText} = intent;
  const lang = userLang||'Arabic';
  const fl   = fromLang||lang;
  const tl   = toLang||'English';

  // ─── تنفيذ الأوامر ──────────────────────────────────────────────────────

  if (cmd==='HELP') { await send(HELP_TEXT); return; }

  if (cmd==='MY_SCORE') {
    const p = db.players[String(uid)];
    const displayName = p?.name || String(uid);
    await send(`🏆 ${displayName}: ${p?.pts||0} نقطة`);
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
    // إذا كان الوضع التلقائي مفعّلاً → ابدأ اللعبة التالية حتى بعد انتهاء الوقت
    if (autoSt[cid]?.active) {
      await runAutoNow(cid);
      return;
    }
    // إذا كانت هناك لعبة يدوية نشطة → ابدأ سؤالاً جديداً من نفس النوع
    if (hasGame) {
      await startGame(cid, games[cid].type, games[cid].lang, games[cid].fromLang, games[cid].toLang);
      return;
    }
    await send('⚠️ لا توجد لعبة الآن.');
    return;
  }

  // الأوامر التلقائية الخمسة
  const AUTO_MAP = {
    AUTO_GAME_GUESS: 'GAME_GUESS', AUTO_GAME_WORD: 'GAME_WORD',
    AUTO_GAME_TR_WORD: 'GAME_TR_WORD', AUTO_GAME_TR_SENT: 'GAME_TR_SENT',
    AUTO_GAME_TR_TEXT: 'GAME_TR_TEXT', AUTO_GAME_GRAMMAR: 'GAME_GRAMMAR',
  };
  if (AUTO_MAP[cmd]) {
    const newType = AUTO_MAP[cmd];
    const curAuto = autoSt[cid];
    // منع التداخل فقط إذا كان وضع تلقائي مختلف نشطاً
    if (curAuto?.active && curAuto.type !== newType) {
      const curLabel = LABEL[curAuto.type] || curAuto.type;
      await send(`⚠️ يوجد وضع تلقائي نشط: ${curLabel}\nأوقفه أولاً بنفس الأمر قبل بدء نوع آخر.`);
      return;
    }
    await toggleAuto(cid, newType, lang, fl, tl);
    return;
  }

  // بدء الألعاب
  const GAME_CMDS = ['GAME_GUESS','GAME_WORD','GAME_TR_WORD','GAME_TR_SENT','GAME_TR_TEXT','GAME_GRAMMAR'];
  if (GAME_CMDS.includes(cmd)) {
    // منع التداخل فقط إذا كان الوضع التلقائي نشطاً
    if (autoSt[cid]?.active) {
      const curLabel = LABEL[autoSt[cid].type] || autoSt[cid].type;
      await send(`⚠️ الوضع التلقائي نشط: ${curLabel}\nأوقفه أولاً قبل بدء لعبة يدوية.`);
      return;
    }
    // إذا كان الوضع التلقائي متوقفاً أو لا توجد لعبة → ابدأ مباشرة
    await startGame(cid, cmd, lang, fl, tl);
    return;
  }

  if (cmd==='MEANING') {
    const q = (queryText||text.replace(/^[!！]\S+\s*/,'')).trim();
    if (!q) return;
    if (isVulgar(q)) { await alert('مخالفة ⚠️'); return; }
    await send(`🔍 أبحث عن معنى: ${q}...`);
    try {
      // ─── بحث ذكي بدون ويكاموس — Free Dictionary + DuckDuckGo + ويكيبيديا ──
      const isEnWord = /^[a-zA-Z\s'-]+$/.test(q.trim());
      const mainCode = isEnWord ? 'en' : 'ar';
      const altCode  = isEnWord ? 'ar' : 'en';

      // دالة لتقصير النتيجة — جملة واحدة أو 150 حرف كحد أقصى
      const trim = t => t ? t.split(/[.!?؟]/)[0].trim().slice(0,200) : '';

      // ① ابحث بلغة الكلمة الأصلية
      const def = await aiMeaning(q.trim(), mainCode);
      if (def) { await send(`📚 ${q}\n${trim(def)}`); return; }
      // ② ابحث باللغة المقابلة
      const revDef = await aiMeaning(q.trim(), altCode);
      if (revDef) { await send(`📚 ${q}\n${trim(revDef)}`); return; }
      // ③ احتياط أخير: DuckDuckGo
      const ddg = await duckSearch(q);
      const fallback = ddg.abstract || ddg.definition || (ddg.topics[0]||'');
      if (fallback.length > 10) {
        await send(`📚 ${q}\n${trim(fallback)}`);
        return;
      }
      await alert(`⚠️ لم أجد معنى لـ "${q}". جرّب كتابة الكلمة بشكل مختلف.`);
    } catch(e) {
      console.error('[MEANING ERR]', e.message?.slice(0,60));
      await alert('⚠️ تعذّر البحث، تحقق من الاتصال بالإنترنت.');
    }
    return;
  }

  if (cmd==='TRANSLATE') {
    const q = (queryText||text.replace(/^[!！]\S+\s*/,'')).trim();
    if (!q) return;
    if (isVulgar(q)) { await alert('مخالفة ⚠️'); return; }
    await send('🌐 أبحث في ويكاموس...');
    try {
      // ─── الترجمة عبر ويكاموس (Wiktionary) ──────────────────────────────
      const fromCode = LANG_CODES[fl] || (detectLang(q)==='Arabic'?'ar':'en');
      const toCode   = LANG_CODES[tl] || (fromCode==='ar'?'en':'ar');
      const result = await aiTranslate(q.trim(), fromCode, toCode);
      if (result && result!==q) { await send(`🌐 ${q}\n➜ ${result}`); return; }
      // ترجمة عكسية
      const revResult = await aiTranslate(q.trim(), toCode, fromCode);
      if (revResult && revResult!==q) { await send(`🌐 ${q}\n➜ ${revResult}`); return; }
      await alert(`⚠️ لم أجد ترجمة لـ "${q}" في ويكاموس.`);
    } catch(e) {
      console.error('[TRANSLATE ERR]', e.message?.slice(0,60));
      await alert('⚠️ تعذّرت الترجمة، تحقق من الاتصال بالإنترنت.');
    }
    return;
  }

  // ─── !بحث — بحث حر في الإنترنت عبر DuckDuckGo ───────────────────────────
  if (cmd==='SEARCH') {
    const q = (queryText||text.replace(/^[!！]\S+\s*/,'')).trim();
    if (!q) { await send('🔍 اكتب: !بحث [كلمة أو جملة]'); return; }
    if (isVulgar(q)) { await alert('مخالفة ⚠️'); return; }
    await send(`🔍 أبحث عن: ${q}...`);
    try {
      const ddg = await duckSearch(q);
      const lines = [];
      if (ddg.abstract)   lines.push(`📄 ${ddg.abstract.slice(0,300)}`);
      else if (ddg.definition) lines.push(`📖 ${ddg.definition.slice(0,300)}`);
      if (ddg.answer)     lines.push(`💡 ${ddg.answer}`);
      ddg.topics.slice(0,3).forEach(t => t && lines.push(`• ${t.slice(0,120)}`));
      if (lines.length === 0) {
        // احتياط: ويكاموس
        const code = detectLang(q)==='Arabic' ? 'ar' : 'en';
        const def  = await aiMeaning(q, code);
        if (def) lines.push(`📚 ${def.slice(0,300)}`);
      }
      if (lines.length > 0) {
        await send(`🔍 نتائج: ${q}\n━━━━━━━━━━\n${lines.join('\n')}`);
      } else {
        await alert(`⚠️ لم أجد نتائج لـ "${q}".`);
      }
    } catch(e) {
      console.error('[SEARCH ERR]', e.message?.slice(0,60));
      await alert('⚠️ تعذّر البحث، تحقق من الاتصال بالإنترنت.');
    }
    return;
  }
});

// ─── دالة مساعدة للوضع التلقائي بعد الإجابة ─────────────────────────────────
async function runAutoNow(cid) {
  const a = autoSt[cid];
  if (!a?.active) return;
  await startGame(cid, a.type, a.lang, a.fromLang, a.toLang);
}

// ─── خادم HTTP للإبقاء على البوت حياً ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`🤖 Wolf Bot يعمل | متصل=${_connected} | ${new Date().toLocaleString('ar')}`);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] خادم الإبقاء يعمل على المنفذ ${PORT}`);
});

// ─── Self-ping كل 4 دقائق — يمنع Replit من إدخال المشروع في وضع الخمول ──────
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
}, 4 * 60 * 1000); // كل 4 دقائق

// ─── حماية شاملة من الانهيار — البوت لا يتوقف أبداً ──────────────────────────
process.on('uncaughtException', e => {
  console.error('[CRASH]', e.message);
  if (!_connected) scheduleReconnect('uncaughtException');
});
process.on('unhandledRejection', e => {
  console.error('[REJ]', String(e).slice(0, 120));
});

// ─── نبضة قلب كل دقيقة ───────────────────────────────────────────────────────
setInterval(() => console.log(`[💓] ${new Date().toLocaleTimeString('ar')} | متصل=${_connected}`), 60000);

// ─── تشغيل ───────────────────────────────────────────────────────────────────
console.log('[BOT] 🚀 جاري التشغيل...');
client.login(BOT_EMAIL, BOT_PASS).catch(e => {
  console.error('[LOGIN ERR]', e.message);
  scheduleReconnect('initial login failed');
});
