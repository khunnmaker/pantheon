import React, { useState, useRef, useEffect } from "react";
import { Send, Check, Bot, User, AlertTriangle, Database, Loader2, Plus, Clock, LogIn, LogOut, Sparkles, Brain, RefreshCw, Search, CheckCircle2 } from "lucide-react";

const KB0 = [
  { id: "KB-01", cat: "สินค้าที่เราทำเอง", q: "ฟูลไรด์เจลคืออะไร มีรสอะไร ใช้อย่างไร", a: "ฟูลไรด์เจล (Fluoride Gel) เป็นเจลฟลูออไรด์สำหรับเคลือบฟันเพื่อป้องกันฟันผุ ใช้ในคลินิกทันตกรรม มีให้เลือกหลายรสชาติ วิธีใช้ทั่วไปคือทาเจลบนถาดครอบฟันแล้วให้คนไข้กัดไว้ตามเวลาที่กำหนด (โปรดดูคำแนะนำบนฉลาก)" },
  { id: "KB-02", cat: "การจัดส่ง", q: "จัดส่งกี่วัน ค่าส่งเท่าไหร่ ส่งยังไง", a: "จัดส่งทั่วประเทศผ่านขนส่งเอกชน โดยทั่วไป 2-3 วันทำการหลังยืนยันคำสั่งซื้อ ค่าจัดส่งขึ้นกับพื้นที่และน้ำหนัก เจ้าหน้าที่จะแจ้งยืนยันอีกครั้งตอนสรุปออเดอร์" },
  { id: "KB-03", cat: "วิธีสั่งซื้อ", q: "สั่งซื้อยังไง", a: "สั่งซื้อได้ผ่าน LINE นี้เลย แจ้งชื่อสินค้า จำนวน และที่อยู่จัดส่ง เจ้าหน้าที่จะสรุปยอดและวิธีชำระเงินให้" },
  { id: "KB-04", cat: "การชำระเงิน", q: "ชำระเงินยังไง โอนได้ไหม รับบัตรไหม", a: "รับชำระผ่านการโอนเงินผ่านธนาคาร และบัตรเครดิต/เดบิต เมื่อชำระแล้วส่งหลักฐานการโอนให้เจ้าหน้าที่เพื่อยืนยัน" },
  { id: "KB-05", cat: "นโยบายคืนสินค้า", q: "คืนสินค้าได้ไหม เปลี่ยนได้ไหม", a: "กรณีสินค้าชำรุดจากการผลิตหรือส่งผิดรายการ ติดต่อขอเปลี่ยน/คืนได้ โปรดเก็บสินค้าและบรรจุภัณฑ์ไว้ พร้อมแจ้งเจ้าหน้าที่และส่งรูปถ่ายประกอบ" },
  { id: "KB-06", cat: "ติดต่อ / เวลาทำการ", q: "เปิดกี่โมง ติดต่อยังไง", a: "เปิดทำการ จันทร์-ศุกร์ 9:00-17:00 น. ติดต่อผ่าน LINE นี้ได้ตลอด เจ้าหน้าที่ตอบกลับในเวลาทำการ" },
  { id: "KB-07", cat: "ใบกำกับภาษี", q: "ขอใบกำกับภาษีได้ไหม", a: "ออกใบกำกับภาษีได้ กรุณาแจ้งชื่อบริษัท ที่อยู่ และเลขประจำตัวผู้เสียภาษีตอนสั่งซื้อ" },
  { id: "KB-08", cat: "ราคา (ต้องให้คนยืนยัน)", q: "ราคาเท่าไหร่ ราคาสินค้า", a: "ข้อมูลราคาต้องให้เจ้าหน้าที่ยืนยันเป็นปัจจุบัน — ไม่อยู่ในข้อมูลของ AI" },
  { id: "KB-09", cat: "สต็อก (ต้องให้คนยืนยัน)", q: "มีของไหม พร้อมส่งไหม ของหมดหรือยัง", a: "สถานะสต็อกต้องให้เจ้าหน้าที่ตรวจสอบระบบคลังก่อน — ไม่อยู่ในข้อมูลของ AI" },
  { id: "KB-10", cat: "ภาพรวมสินค้า", q: "มีขายอะไรบ้าง สินค้าอะไรบ้าง", a: "เรามีอุปกรณ์และวัสดุทันตกรรมหลากหลาย รวมถึงสินค้าที่บริษัทผลิตเอง เช่น ฟูลไรด์เจล สอบถามสินค้าที่สนใจได้เลย เจ้าหน้าที่จะให้รายละเอียดเพิ่ม" },
];

const EXAMPLES = ["ฟูลไรด์เจลมีรสอะไรบ้างคะ", "สั่งของกี่วันถึงคะ", "ราคาเท่าไหร่คะ", "ฟันลูกเป็นรูเล็กๆ ควรทำยังไงดีคะ", "ขอใบกำกับภาษีได้ไหมคะ"];
const STAFF = ["คุณมายด์", "คุณฟ้า", "NaDeer"];
const HELLO = { role: "shop", text: "สวัสดีค่ะ ยินดีให้บริการค่ะ 😊 สอบถามสินค้าได้เลยนะคะ" };
const RECENT = 5;       // ข้อความล่าสุดที่ส่งเต็มๆ (ตั้งเล็กเพื่อให้เห็น retrieval ในเดโม)
const RETRIEVE_K = 2;   // ดึงข้อความเก่าที่เกี่ยวสูงสุดกี่ข้อความ
const MIN_SIM = 0.06;

const SEED = {
  agent: "", kb: KB0, learned: [], summaries: {},
  customers: [{ id: "c1", name: "คุณนภา · คลินิกฟันดี" }, { id: "c2", name: "คุณวีร์ · เดนทัลแคร์" }],
  conversations: {
    c1: [HELLO],
    c2: [HELLO,
      { role: "customer", text: "ฟูลไรด์เจลมีรสอะไรบ้างคะ", t: "2026-06-18T10:02:00" },
      { role: "shop", text: "ฟูลไรด์เจลมีให้เลือกหลายรสชาติค่ะ หากต้องการทราบรสที่มีในสต็อกตอนนี้ เดี๋ยวเจ้าหน้าที่เช็คให้นะคะ 😊", by: "คุณฟ้า", kb: ["KB-01"], t: "2026-06-18T10:05:00" },
    ],
  },
};
const SKEY = "prominent_cs_v5";

const hasStore = typeof window !== "undefined" && window.storage;
async function loadData() { if (!hasStore) return null; try { const r = await window.storage.get(SKEY); return r && r.value ? JSON.parse(r.value) : null; } catch { return null; } }
async function saveData(d) { if (!hasStore) return; try { await window.storage.set(SKEY, JSON.stringify(d)); } catch {} }
function fmtTime(t) { if (!t) return ""; try { const d = new Date(t); return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }

// ── retrieval ด้วย character n-gram (รองรับภาษาไทยที่ไม่มีเว้นวรรค) ──
function ngrams(s, n = 2) { const t = (s || "").toLowerCase().replace(/\s+/g, ""); const g = new Set(); for (let i = 0; i <= t.length - n; i++) g.add(t.slice(i, i + n)); return g; }
function sim(a, b) { const A = ngrams(a), B = ngrams(b); if (!A.size || !B.size) return 0; let inter = 0; A.forEach(x => { if (B.has(x)) inter++; }); return inter / (A.size + B.size - inter); }
function retrieve(question, older) { return older.map(m => ({ m, s: sim(question, m.text) })).filter(x => x.s >= MIN_SIM).sort((a, b) => b.s - a.s).slice(0, RETRIEVE_K).map(x => x.m); }

function buildPrompt(question, summary, retrievedTxt, recentTxt, kb) {
  const kbText = kb.map(k => `[${k.id}] หมวด: ${k.cat}\n   คำถามที่เกี่ยวข้อง: ${k.q}\n   คำตอบ: ${k.a}`).join("\n\n");
  return `คุณคือผู้ช่วย "ร่าง" คำตอบให้ลูกค้าของบริษัท Prominent (จำหน่ายอุปกรณ์ทันตกรรม) ผ่าน LINE คำตอบจะถูกพนักงานตรวจก่อนส่งจริงเสมอ

ฐานความรู้ (KB):
${kbText}
${summary ? `\nสรุป/ความจำระยะยาวของลูกค้าคนนี้:\n${summary}\n` : ""}${retrievedTxt ? `\nข้อความเก่าที่เกี่ยวข้องกับคำถามนี้ (ระบบดึงมาเฉพาะที่เกี่ยว):\n${retrievedTxt}\n` : ""}${recentTxt ? `\nข้อความล่าสุดในบทสนทนา:\n${recentTxt}\n` : ""}
กฎสำคัญ:
1. ตอบจาก KB เท่านั้น ห้ามแต่งข้อมูล/ตัวเลขเพิ่มเอง
2. ถ้าถามเรื่อง "ราคา" หรือ "มีของ/สต็อก/พร้อมส่ง" → type "needs_human", draft สุภาพว่าขอเช็คให้สักครู่ ห้ามเดาตัวเลข
3. คำถามเชิงคลินิก/การรักษา/วินิจฉัยอาการ → type "needs_human", note ว่าต้องให้ทันตแพทย์/ผู้เชี่ยวชาญตอบ
4. KB ไม่ครอบคลุม → type "out_of_scope"
5. ตอบได้ → type "draft"
6. ใช้ความจำ/ข้อความเก่า/ข้อความล่าสุด เพื่อความต่อเนื่อง
7. โทน: พนักงานบริการหญิง สุภาพ อบอุ่น กระชับ ลงท้าย ค่ะ/คะ

ตอบ JSON อย่างเดียว: {"type":"draft|needs_human|out_of_scope","draft":"...","used_kb":["KB-01"],"note":"..."}

คำถามลูกค้า: "${question}"`;
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }) });
  if (!res.ok) throw new Error("API " + res.status);
  const data = await res.json();
  return data.content.filter(b => b.type === "text").map(b => b.text).join("");
}
async function generateDraft(q, sum, ret, rec, kb) { const t = await callClaude(buildPrompt(q, sum, ret, rec, kb)); return JSON.parse(t.replace(/```json/gi, "").replace(/```/g, "").trim()); }
async function generateSummary(history) { return (await callClaude(`สรุปประวัติลูกค้าคนนี้ให้กระชับ 2-3 ประโยค ครอบคลุมว่าเคยถาม/สนใจ/ซื้ออะไร เพื่อใช้เป็น "ความจำ" ให้ตอบครั้งต่อไปต่อเนื่อง ตอบเป็นข้อความธรรมดาภาษาไทย ไม่มีหัวข้อ/bullet\n\nบทสนทนาทั้งหมด:\n${history}`)).trim(); }
const histLine = m => (m.role === "customer" ? "ลูกค้า" : m.role === "shop" ? "ร้าน" : "") + ": " + m.text;

const TYPE_META = { draft: { label: "ร่างพร้อมส่ง", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" }, needs_human: { label: "ต้องให้คนตอบ", cls: "bg-amber-100 text-amber-700 border-amber-300" }, out_of_scope: { label: "นอกขอบเขต", cls: "bg-slate-100 text-slate-600 border-slate-300" } };

export default function App() {
  const [data, setData] = useState(SEED);
  const [active, setActive] = useState(SEED.customers[0].id);
  const [input, setInput] = useState(""); const [newName, setNewName] = useState(""); const [loginName, setLoginName] = useState("");
  const [loading, setLoading] = useState(false); const [draft, setDraft] = useState(null); const [editText, setEditText] = useState(""); const [error, setError] = useState("");
  const [autoBusy, setAutoBusy] = useState(false); const [usedMemory, setUsedMemory] = useState(false); const [retrieved, setRetrieved] = useState([]); const [savedToast, setSavedToast] = useState(false);
  const endRef = useRef(null); const dataRef = useRef(data); const prevId = useRef(active); const summarizing = useRef(new Set());
  useEffect(() => { dataRef.current = data; });

  useEffect(() => { (async () => { const loaded = await loadData(); if (loaded && loaded.customers && loaded.customers.length) { setData({ ...SEED, ...loaded }); setActive(loaded.customers[0].id); } else await saveData(SEED); })(); }, []);

  const conv = data.conversations[active] || [];
  const customer = data.customers.find(c => c.id === active);
  const agent = data.agent;
  const kbMap = Object.fromEntries(data.kb.map(k => [k.id, k]));
  const custQuestions = conv.filter(m => m.role === "customer");
  const lastT = [...conv].reverse().find(m => m.t)?.t;
  const topics = [...new Set(conv.flatMap(m => (m.kb || []).map(id => kbMap[id]?.cat).filter(Boolean)))];
  const savedSummary = data.summaries?.[active]?.text || "";
  const summaryAt = data.summaries?.[active]?.at || 0;
  const memoryStale = conv.length > summaryAt && custQuestions.length > 0;

  useEffect(() => { if (prevId.current && prevId.current !== active) summarize(prevId.current, false); prevId.current = active; setDraft(null); setError(""); setUsedMemory(false); setRetrieved([]); }, [active]); // eslint-disable-line
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [conv.length, loading, active]);

  function commit(next) { setData(next); saveData(next); }
  function setConv(custId, msgs) { commit({ ...dataRef.current, conversations: { ...dataRef.current.conversations, [custId]: msgs } }); }
  function login(name) { const n = (name || "").trim(); if (!n) return; commit({ ...data, agent: n }); setLoginName(""); }
  function logout() { commit({ ...data, agent: "" }); }
  function addCustomer() { const name = newName.trim() || `ลูกค้าใหม่ #${data.customers.length + 1}`; const id = "c" + Date.now(); commit({ ...data, customers: [...data.customers, { id, name }], conversations: { ...data.conversations, [id]: [HELLO] } }); setActive(id); setNewName(""); }

  // สรุปความจำ — auto (force=false ทำเฉพาะเมื่อมีข้อความใหม่) / manual (force=true)
  async function summarize(custId, force) {
    const d = dataRef.current; const c = d.conversations[custId] || [];
    if (!c.some(m => m.role === "customer")) return;
    const at = d.summaries?.[custId]?.at || 0;
    if (!force && c.length <= at) return;
    if (summarizing.current.has(custId)) return;
    summarizing.current.add(custId); setAutoBusy(true);
    try {
      const s = await generateSummary(c.map(histLine).join("\n"));
      const dd = dataRef.current;
      commit({ ...dd, summaries: { ...(dd.summaries || {}), [custId]: { text: s, at: (dd.conversations[custId] || []).length } } });
      if (force) { setSavedToast(true); setTimeout(() => setSavedToast(false), 2200); }
    } catch (e) { if (force) setError("สรุปไม่สำเร็จ: " + e.message); }
    finally { summarizing.current.delete(custId); setAutoBusy(false); }
  }

  async function ask(q) {
    const question = (q ?? input).trim();
    if (!question || loading || !active) return;
    const prior = data.conversations[active] || [];
    setConv(active, [...prior, { role: "customer", text: question, t: new Date().toISOString() }]);
    setInput(""); setDraft(null); setError(""); setLoading(true);
    const memory = data.summaries?.[active]?.text || "";
    const recent = prior.slice(-RECENT);
    const older = prior.slice(0, Math.max(0, prior.length - RECENT));
    const ret = retrieve(question, older);
    setUsedMemory(!!memory); setRetrieved(ret);
    try {
      const result = await generateDraft(question, memory, ret.map(histLine).join("\n"), recent.map(histLine).join("\n"), data.kb);
      setDraft(result); setEditText(result.draft || "");
    } catch (e) { setError("ดึงคำตอบไม่สำเร็จ: " + e.message); }
    finally { setLoading(false); }
  }

  function approve() {
    if (!editText.trim() || !active || !agent || !draft) return;
    const finalAns = editText.trim(); const edited = finalAns !== (draft.draft || "").trim();
    const lastQ = [...(data.conversations[active] || [])].reverse().find(m => m.role === "customer")?.text || "";
    const newMsgs = [...(data.conversations[active] || []), { role: "shop", text: finalAns, by: agent, kb: draft.used_kb || [], t: new Date().toISOString() }];
    let learned = data.learned;
    if (edited && lastQ) learned = [{ id: "L" + Date.now(), question: lastQ, aiDraft: draft.draft || "", finalAnswer: finalAns, agent, t: new Date().toISOString(), promoted: false }, ...data.learned];
    commit({ ...data, conversations: { ...data.conversations, [active]: newMsgs }, learned });
    setDraft(null); setEditText(""); setRetrieved([]);
  }
  function promote(rec) { const id = "KB-U" + (data.kb.filter(k => k.id.startsWith("KB-U")).length + 1); const kb = [...data.kb, { id, cat: "เรียนรู้จากพนักงาน", q: rec.question, a: rec.finalAnswer }]; const learned = data.learned.map(l => l.id === rec.id ? { ...l, promoted: true } : l); commit({ ...data, kb, learned }); }

  return (
    <div className="min-h-screen bg-slate-100 p-3 sm:p-5 font-sans text-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 text-teal-700"><Bot size={22} /><h1 className="text-xl sm:text-2xl font-bold">ต้นแบบ: AI ตอบลูกค้า LINE — ความจำอัตโนมัติ + Retrieval</h1></div>
            <p className="text-sm text-slate-500 mt-1">AI ใช้ <span className="font-semibold text-teal-700">สรุประยะยาว + ข้อความเก่าที่เกี่ยว (retrieval) + ข้อความล่าสุด</span> · ความจำอัปเดตเองเมื่อจบแชท</p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {autoBusy && <span className="text-xs text-teal-600 flex items-center gap-1 bg-teal-50 border border-teal-200 rounded-lg px-2 py-1"><Loader2 size={12} className="animate-spin" /> อัปเดตความจำ…</span>}
            {agent
              ? <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm shadow-sm"><span className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-bold">{agent.replace(/^คุณ/, "").charAt(0)}</span><span className="font-semibold text-slate-700">{agent}</span><button onClick={logout} className="text-slate-400 hover:text-rose-500" title="ออกจากระบบ"><LogOut size={15} /></button></div>
              : <div className="flex items-center gap-1 bg-white border border-amber-300 rounded-xl px-2 py-1.5 text-xs shadow-sm"><input value={loginName} onChange={e => setLoginName(e.target.value)} onKeyDown={e => e.key === "Enter" && login(loginName)} placeholder="ชื่อพนักงาน" className="w-24 px-1 py-0.5 outline-none" />{STAFF.map(s => <button key={s} onClick={() => login(s)} className="px-1.5 py-0.5 rounded bg-slate-100 hover:bg-teal-100 text-slate-600">{s}</button>)}<button onClick={() => login(loginName)} className="px-2 py-0.5 rounded bg-teal-600 text-white flex items-center gap-1"><LogIn size={12} /></button></div>}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {/* ลูกค้า */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[620px]">
            <div className="px-4 py-3 bg-green-600 text-white rounded-t-2xl font-semibold flex items-center justify-between">
              <span className="flex items-center gap-2"><User size={18} /> มุมมองลูกค้า (LINE)</span>
              {custQuestions.length > 0 && <button onClick={() => summarize(active, true)} disabled={autoBusy} className="text-xs bg-green-700 hover:bg-green-800 disabled:opacity-50 px-2 py-1 rounded-lg flex items-center gap-1" title="จบบทสนทนา แล้วสรุปความจำ"><CheckCircle2 size={13} /> จบแชท</button>}
            </div>
            <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 space-y-2">
              <div className="flex items-center gap-2">
                <select value={active} onChange={e => setActive(e.target.value)} className="flex-1 text-sm px-2 py-1.5 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-teal-400">{data.customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                {custQuestions.length > 0 && <span className="text-xs px-2 py-1 rounded-full bg-teal-100 text-teal-700 border border-teal-200 flex items-center gap-1 whitespace-nowrap"><Clock size={12} /> ลูกค้าเดิม</span>}
              </div>
              <div className="flex gap-2"><input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && addCustomer()} placeholder="ชื่อลูกค้าใหม่…" className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-400" /><button onClick={addCustomer} className="text-xs px-2 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 flex items-center gap-1"><Plus size={13} /> เพิ่มลูกค้า</button></div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-green-50">
              {conv.map((m, i) => (
                <div key={i}>
                  <div className={m.role === "customer" ? "flex justify-start" : m.role === "shop" ? "flex justify-end" : "flex justify-center"}>
                    {m.role === "system" ? <span className="text-xs text-slate-400 italic py-1">{m.text}</span> : <div className={"max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap " + (m.role === "customer" ? "bg-white border border-slate-200 rounded-tl-sm" : "bg-teal-600 text-white rounded-tr-sm")}>{m.text}</div>}
                  </div>
                  {m.role === "shop" && m.by && <div className="flex justify-end pr-1"><span className="text-[10px] text-slate-400 mt-0.5">— ตอบโดย {m.by}</span></div>}
                </div>
              ))}
              {loading && <div className="flex justify-end"><div className="bg-teal-600 text-white px-3 py-2 rounded-2xl rounded-tr-sm text-sm flex items-center gap-2 opacity-80"><Loader2 size={14} className="animate-spin" /> กำลังร่างคำตอบ…</div></div>}
              <div ref={endRef} />
            </div>
            <div className="p-3 border-t border-slate-200 space-y-2">
              <div className="flex flex-wrap gap-1">{EXAMPLES.map((ex, i) => <button key={i} onClick={() => ask(ex)} disabled={loading} className="text-xs px-2 py-1 rounded-full bg-slate-100 hover:bg-teal-100 text-slate-600 border border-slate-200 disabled:opacity-50">{ex}</button>)}</div>
              <div className="flex gap-2"><input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && ask()} placeholder="พิมพ์คำถามลูกค้า…" className="flex-1 px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" /><button onClick={() => ask()} disabled={loading} className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-50 flex items-center gap-1"><Send size={16} /></button></div>
            </div>
          </div>

          {/* คอนโซล */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[620px]">
            <div className="px-4 py-3 bg-teal-700 text-white rounded-t-2xl font-semibold flex items-center gap-2"><Bot size={18} /> คอนโซลพนักงาน — ตรวจก่อนส่ง</div>
            {!agent ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-sm p-6 text-center"><LogIn size={36} className="mb-3 text-amber-500" />กรุณา <b className="mx-1">เข้าสู่ระบบ</b> (มุมขวาบน) เพื่อระบุว่าใครเป็นผู้ตอบลูกค้า</div>
            ) : (
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1"><span className="text-xs font-bold text-slate-600 flex items-center gap-1"><Sparkles size={13} className="text-teal-600" /> สรุปประวัติลูกค้า</span><span className="text-[11px] text-slate-400">{customer?.name}</span></div>
                  <div className="text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1"><span>เคยถาม: <b>{custQuestions.length}</b> คำถาม</span>{lastT && <span>ติดต่อล่าสุด: <b>{fmtTime(lastT)}</b></span>}{topics.length > 0 && <span>สนใจ: <b>{topics.join(", ")}</b></span>}</div>
                  {savedSummary && <div className="text-xs text-teal-800 bg-teal-50 border border-teal-200 rounded-lg p-2 mt-2"><span className="font-bold flex items-center gap-1 mb-0.5"><Brain size={12} /> ความจำระยะยาว (AI ใช้ทุกคำตอบ){memoryStale && <span className="text-amber-600 font-normal">· มีบทสนทนาใหม่หลังสรุป</span>}</span>{savedSummary}</div>}
                  {savedToast && <div className="text-[11px] text-emerald-600 mt-2 flex items-center gap-1"><CheckCircle2 size={12} /> อัปเดตความจำแล้ว</div>}
                  <div className="text-[11px] text-slate-400 mt-2">ความจำจะอัปเดต<b>อัตโนมัติเมื่อจบแชท</b> (สลับลูกค้า/กดปุ่มจบแชท)</div>
                </div>

                {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-xl p-3">{error}</div>}
                {!draft && !error && <div className="text-slate-400 text-sm text-center py-8">รอคำถามจากลูกค้า… ร่างคำตอบจะมาแสดงที่นี่</div>}
                {draft && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className={"text-xs font-semibold px-2 py-1 rounded-full border " + TYPE_META[draft.type]?.cls}>{TYPE_META[draft.type]?.label || draft.type}</span>
                      <div className="flex items-center gap-2">{usedMemory && <span className="text-[11px] text-teal-600 flex items-center gap-1"><Brain size={12} /> ความจำ</span>}{draft.type !== "draft" && <span className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={13} /> ต้องตรวจ/เติม</span>}</div>
                    </div>
                    {retrieved.length > 0 && (
                      <div className="text-xs bg-indigo-50 border border-indigo-200 rounded-lg p-2">
                        <span className="font-bold text-indigo-700 flex items-center gap-1 mb-1"><Search size={12} /> Retrieval — ดึงข้อความเก่าที่เกี่ยว ({retrieved.length})</span>
                        {retrieved.map((m, i) => <div key={i} className="text-indigo-900/80 truncate">• {m.text}</div>)}
                      </div>
                    )}
                    {draft.note && <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2 border border-slate-200">เหตุผล: {draft.note}</div>}
                    <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={5} className="w-full p-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 resize-none" />
                    {editText.trim() !== (draft.draft || "").trim() && <div className="text-[11px] text-amber-600 flex items-center gap-1"><Brain size={12} /> มีการแก้ — จะถูกเก็บเข้าคลังการเรียนรู้</div>}
                    {draft.used_kb && draft.used_kb.length > 0 && <div><span className="text-xs font-semibold text-slate-500 flex items-center gap-1 mb-1"><Database size={12} /> ใช้ข้อมูลจาก KB</span><div className="flex flex-wrap gap-1">{draft.used_kb.map(id => <span key={id} className="text-xs px-2 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200">{id}</span>)}</div></div>}
                    <div className="flex gap-2 pt-1"><button onClick={approve} className="flex-1 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1"><Check size={16} /> อนุมัติ &amp; ส่ง</button><button onClick={() => setEditText("")} className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-semibold flex items-center gap-1"><RefreshCw size={15} /> เขียนใหม่</button></div>
                  </div>
                )}
              </div>
            )}
            <div className="px-4 py-2 border-t border-slate-200 text-xs text-slate-400">🔒 ราคา/สต็อก/คำถามคลินิก → ระบบไม่ตอบเอง ให้คนจัดการเสมอ</div>
          </div>
        </div>

        {/* คลังการเรียนรู้ */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 mt-4 p-4">
          <div className="flex items-center justify-between mb-2"><span className="font-bold text-slate-700 flex items-center gap-2"><Brain size={18} className="text-teal-600" /> คลังการเรียนรู้ — คำตอบที่พนักงานแก้/ปรับ</span><span className="text-xs text-slate-500">KB ปัจจุบัน: <b className="text-teal-700">{data.kb.length}</b> · เรียนรู้ใหม่: <b className="text-teal-700">{data.learned.length}</b></span></div>
          {data.learned.length === 0
            ? <p className="text-sm text-slate-400 py-3">ยังไม่มี — เมื่อพนักงาน<b>แก้ร่างของ AI</b>แล้วส่ง ระบบจะเก็บคำตอบไว้ที่นี่ แล้วกด "เพิ่มเข้า KB" เพื่อให้ AI ตอบดีขึ้นครั้งหน้า</p>
            : <div className="space-y-2">{data.learned.map(rec => (
                <div key={rec.id} className="border border-slate-200 rounded-xl p-3 text-sm">
                  <div className="text-slate-500 text-xs mb-1">ถาม: <span className="text-slate-700">{rec.question}</span> · โดย {rec.agent}</div>
                  <div className="grid sm:grid-cols-2 gap-2 mb-2"><div className="bg-slate-50 rounded-lg p-2 text-xs text-slate-500"><b className="text-slate-400">ร่างเดิมของ AI:</b><br />{rec.aiDraft || "—"}</div><div className="bg-emerald-50 rounded-lg p-2 text-xs text-emerald-800"><b className="text-emerald-600">คำตอบที่พนักงานปรับ:</b><br />{rec.finalAnswer}</div></div>
                  {rec.promoted ? <span className="text-xs text-teal-600 flex items-center gap-1"><Check size={13} /> เพิ่มเข้า KB แล้ว — AI จะใช้ครั้งต่อไป</span> : <button onClick={() => promote(rec)} className="text-xs px-3 py-1 rounded-lg bg-teal-600 hover:bg-teal-700 text-white flex items-center gap-1"><Plus size={13} /> เพิ่มเข้า KB (สอน AI)</button>}
                </div>))}</div>}
        </div>

        <p className="text-xs text-slate-400 mt-3 text-center">* ความจำ 3 ชั้น: สรุประยะยาว (อัปเดตอัตโนมัติเมื่อจบแชท) + retrieval ดึงข้อความเก่าที่เกี่ยว + ล่าสุด {RECENT} ข้อความ · เดโมใช้ n-gram; production ใช้ vector embeddings · KB เป็นข้อมูลสมมติ</p>
      </div>
    </div>
  );
}
