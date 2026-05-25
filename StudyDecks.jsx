import { useState, useEffect, useCallback, useRef } from "react";

// ─── Supabase ─────────────────────────────────────────────────────────────────
// Replace these two values with your own from Supabase → Project Settings → API
const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";

async function sbFetch(path, options = {}) {
  const session = getSession();
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
    ...(session ? { "Authorization": `Bearer ${session.access_token}` } : {}),
    ...options.headers,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Supabase error ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function sbAuth(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Auth error");
  return data;
}

function getSession() {
  try { return JSON.parse(localStorage.getItem("sb-session")); } catch { return null; }
}
function saveSession(s) { localStorage.setItem("sb-session", s ? JSON.stringify(s) : ""); }

// ─── FSRS ────────────────────────────────────────────────────────────────────
const FSRS_W = [0.4072,1.1829,3.1262,15.4722,7.2102,0.5316,1.0651,0.06,0.5582,0.1122,1.0128,1.9216,0.1104,0.29,2.2700,0.1419,2.8693];

function initCard() {
  return { stability:0, difficulty:0, elapsed_days:0, scheduled_days:0, reps:0, lapses:0, state:"new", last_review:null, due:new Date() };
}

function fsrsSchedule(card, rating) {
  const w = FSRS_W;
  let { stability, difficulty, reps, lapses, state } = card;
  const now = new Date();
  const r = Math.pow(1 + (card.elapsed_days / (9 * (stability||1))), -1);
  let ns, nd;

  if (!reps || state === "new") {
    nd = Math.min(10, Math.max(1, w[4] - Math.exp(w[5]*(rating-1)) + 1));
    ns = [w[0],w[1],w[2],w[3]][rating-1] || w[2];
    state = "learning"; reps = 1;
  } else if (state === "learning" || state === "relearning") {
    nd = Math.min(10, Math.max(1, difficulty + w[6]*(4-rating) - w[7]*(difficulty-5)/(1+Math.exp(-w[5]))));
    if (rating >= 3) { ns = Math.max(0.1, stability * Math.exp(w[8]*(11-nd)*Math.pow(stability,-w[9])*(Math.exp((1-r)*w[10])-1))); state = "review"; reps++; }
    else { ns = w[0]; lapses++; state = "relearning"; }
  } else {
    nd = Math.min(10, Math.max(1, difficulty + w[6]*(4-rating) - w[7]*(difficulty-5)/(1+Math.exp(-w[5]))));
    if (rating === 1) { ns = w[0]; lapses++; state = "relearning"; }
    else {
      const hard = rating===2?w[15]:1, easy = rating===4?w[16]:1;
      ns = Math.max(0.1, stability * Math.exp(w[8]*(11-nd)*Math.pow(stability,-w[9])*(Math.exp((1-r)*w[10])-1)) * hard * easy);
      state = "review"; reps++;
    }
  }

  const scheduledDays = state==="review" ? Math.min(36500, Math.max(1, Math.round(ns))) : rating>=3?1:0;
  const due = new Date(now); due.setDate(due.getDate()+scheduledDays);

  return { stability:ns||w[0], difficulty:nd||5, elapsed_days:card.last_review?Math.round((now-new Date(card.last_review))/86400000):0, scheduled_days:scheduledDays, reps, lapses, state, last_review:now.toISOString(), due:due.toISOString() };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function generateId() { return crypto.randomUUID?.() || "id-"+Math.random().toString(36).slice(2,10); }

function getDueCards(deck) {
  const now = new Date();
  return deck.cards.filter(c => {
    const p = c.progress;
    if (!p || p.state==="new" || !p.reps) return true;
    return new Date(p.due) <= now;
  });
}

function deckStats(deck) {
  const total = deck.cards.length;
  const newCards = deck.cards.filter(c => !c.progress || c.progress.state==="new").length;
  const due = getDueCards(deck).length;
  const learned = deck.cards.filter(c => c.progress?.state==="review").length;
  return { total, newCards, due, learned };
}

// ─── Themes ──────────────────────────────────────────────────────────────────
const THEMES = {
  retro:   { name:"Retro Terminal",  bg:"#0d0d0d", surface:"#111", card:"#0a1628", cardBack:"#1a0a00", border:"#2a2a2a", accent:"#00ff88", accentAlt:"#ff6b35", text:"#e8e8e8", muted:"#555", fontDisplay:"'Courier New',monospace", fontBody:"'Courier New',monospace", scanlines:true },
  minimal: { name:"Clean Minimal",   bg:"#f5f5f0", surface:"#fff", card:"#fff",    cardBack:"#f0f4ff", border:"#e0e0e0", accent:"#2563eb", accentAlt:"#7c3aed",  text:"#1a1a1a", muted:"#888", fontDisplay:"Georgia,serif",          fontBody:"system-ui,sans-serif",    scanlines:false },
  medical: { name:"Clinical Blue",   bg:"#0f172a", surface:"#1e293b", card:"#1e293b", cardBack:"#0f2040", border:"#334155", accent:"#38bdf8", accentAlt:"#34d399", text:"#f1f5f9", muted:"#64748b", fontDisplay:"Georgia,serif",     fontBody:"system-ui,sans-serif",    scanlines:false },
};

// ─── Rich Text ────────────────────────────────────────────────────────────────
function inlineRender(text) {
  const parts=[]; let remaining=text, key=0;
  const pats=[{re:/\*\*(.+?)\*\*/,fn:m=><strong key={key++}>{m[1]}</strong>},{re:/\*(.+?)\*/,fn:m=><em key={key++}>{m[1]}</em>},{re:/`(.+?)`/,fn:m=><code key={key++} style={{background:"rgba(128,128,128,0.2)",padding:"1px 5px",borderRadius:3,fontFamily:"monospace",fontSize:"0.9em"}}>{m[1]}</code>}];
  while(remaining){let ei=null,eidx=Infinity,ep=null;for(const p of pats){const m=remaining.match(p.re);if(m){const i=remaining.indexOf(m[0]);if(i<eidx){ei=m;eidx=i;ep=p;}}}if(!ei){parts.push(remaining);break;}if(eidx>0)parts.push(remaining.slice(0,eidx));parts.push(ep.fn(ei));remaining=remaining.slice(eidx+ei[0].length);}
  return parts;
}

function RichText({content}) {
  if(!content)return null;
  const lines=content.split("\n"); const els=[]; let i=0, tbuf=null;
  while(i<lines.length){
    const l=lines[i];
    if(l.trim().startsWith("|")){if(!tbuf)tbuf=[];tbuf.push(l);i++;if(i>=lines.length||!lines[i].trim().startsWith("|")){const rows=tbuf.filter(r=>!r.match(/^\|[-| :]+\|$/));els.push(<div key={i} style={{overflowX:"auto",margin:"0.75rem 0"}}><table style={{borderCollapse:"collapse",width:"100%",fontSize:13}}>{rows.map((row,ri)=>{const cells=row.split("|").filter((_,ci)=>ci>0&&ci<row.split("|").length-1);const Tag=ri===0?"th":"td";return<tr key={ri} style={{borderBottom:"1px solid rgba(128,128,128,0.2)"}}>{cells.map((cell,ci)=><Tag key={ci} style={{padding:"6px 10px",textAlign:"left",fontWeight:ri===0?600:400,opacity:ri===0?1:0.85}}>{cell.trim()}</Tag>)}</tr>})}</table></div>);tbuf=null;}continue;}
    if(tbuf)tbuf=null;
    const h3=l.match(/^### (.+)/),h2=l.match(/^## (.+)/),h1=l.match(/^# (.+)/);
    if(h3){els.push(<h3 key={i} style={{margin:"0.8rem 0 0.2rem",fontSize:12,fontWeight:700,opacity:0.6,textTransform:"uppercase",letterSpacing:"0.1em"}}>{h3[1]}</h3>);i++;continue;}
    if(h2){els.push(<h2 key={i} style={{margin:"0.8rem 0 0.3rem",fontSize:16,fontWeight:700,borderBottom:"1px solid rgba(128,128,128,0.2)",paddingBottom:3}}>{h2[1]}</h2>);i++;continue;}
    if(h1){els.push(<h1 key={i} style={{margin:"0.4rem 0 0.4rem",fontSize:20,fontWeight:800}}>{h1[1]}</h1>);i++;continue;}
    const bq=l.match(/^> (.+)/);
    if(bq){els.push(<blockquote key={i} style={{borderLeft:"3px solid #f39c12",paddingLeft:12,margin:"0.4rem 0",fontStyle:"italic",fontSize:13,opacity:0.9}}>{inlineRender(bq[1])}</blockquote>);i++;continue;}
    const ul=l.match(/^[-*] (.+)/),ol=l.match(/^\d+\. (.+)/);
    if(ul||ol){const items=[];const isol=!!ol;while(i<lines.length&&(lines[i].match(/^[-*] /)||lines[i].match(/^\d+\. /))){const m=lines[i].match(/^[-*] (.+)/)||lines[i].match(/^\d+\. (.+)/);items.push(<li key={i} style={{marginBottom:3}}>{inlineRender(m[1])}</li>);i++;}const LT=isol?"ol":"ul";els.push(<LT key={"l"+i} style={{paddingLeft:20,margin:"0.3rem 0",fontSize:14}}>{items}</LT>);continue;}
    if(l.trim()===""){els.push(<div key={i} style={{height:7}}/>);i++;continue;}
    els.push(<p key={i} style={{margin:"0.25rem 0",fontSize:14,lineHeight:1.65}}>{inlineRender(l)}</p>);i++;
  }
  return <div>{els}</div>;
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({t, onAuth}) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const inp = { width:"100%", background:t.bg, color:t.text, border:`1px solid ${t.border}`, borderRadius:8, padding:"10px 14px", fontFamily:t.fontBody, fontSize:14, outline:"none", boxSizing:"border-box", marginBottom:10 };
  const btn = { width:"100%", background:t.accent, color:t.bg, border:"none", borderRadius:8, padding:"11px 0", cursor:"pointer", fontFamily:t.fontBody, fontWeight:700, fontSize:14, marginTop:4 };

  const handle = async () => {
    setErr(null); setMsg(null); setLoading(true);
    try {
      if (mode==="magic") {
        await sbAuth("magiclink", { email });
        setMsg("Check your email for a magic link!");
      } else if (mode==="signup") {
        const data = await sbAuth("signup", { email, password, data:{ display_name:name } });
        if (data.session) { saveSession(data.session); onAuth(data.user, data.session); }
        else setMsg("Check your email to confirm your account.");
      } else {
        const data = await sbAuth("token?grant_type=password", { email, password });
        saveSession(data); onAuth(data.user, data);
      }
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",background:t.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
      <div style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:16,padding:"2rem",width:"100%",maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:26,fontFamily:t.fontDisplay,fontWeight:800,color:t.accent,letterSpacing:t.scanlines?"0.06em":"0",marginBottom:6}}>
            {t.scanlines?"STUDY_DECKS":"Study Decks"}
          </div>
          <div style={{fontSize:12,color:t.muted,fontFamily:t.fontBody}}>Medical flashcards with spaced repetition</div>
        </div>

        <div style={{display:"flex",gap:6,marginBottom:20}}>
          {[["login","Sign In"],["signup","Sign Up"],["magic","Magic Link"]].map(([m,l])=>(
            <button key={m} onClick={()=>{setMode(m);setErr(null);setMsg(null);}} style={{flex:1,background:mode===m?t.accent:"transparent",color:mode===m?t.bg:t.muted,border:`1px solid ${mode===m?t.accent:t.border}`,borderRadius:6,padding:"6px 0",cursor:"pointer",fontFamily:t.fontBody,fontSize:11}}>
              {l}
            </button>
          ))}
        </div>

        {mode==="signup" && <input style={inp} placeholder="Display name" value={name} onChange={e=>setName(e.target.value)} />}
        <input style={inp} type="email" placeholder="Email address" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()} />
        {mode!=="magic" && <input style={inp} type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()} />}

        {err && <div style={{background:"#e74c3c20",border:"1px solid #e74c3c50",borderRadius:6,padding:"8px 12px",color:"#e74c3c",fontSize:12,marginBottom:10,fontFamily:t.fontBody}}>{err}</div>}
        {msg && <div style={{background:t.accent+"20",border:`1px solid ${t.accent}50`,borderRadius:6,padding:"8px 12px",color:t.accent,fontSize:12,marginBottom:10,fontFamily:t.fontBody}}>{msg}</div>}

        <button style={btn} onClick={handle} disabled={loading}>
          {loading ? "..." : mode==="login"?"Sign In":mode==="signup"?"Create Account":"Send Magic Link"}
        </button>

        {mode==="login" && (
          <button onClick={()=>setMode("magic")} style={{width:"100%",background:"transparent",color:t.muted,border:"none",cursor:"pointer",fontFamily:t.fontBody,fontSize:12,marginTop:12}}>
            Forgot password? Use magic link →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Card Editor ──────────────────────────────────────────────────────────────
function CardEditor({card, onSave, onCancel, t}) {
  const [front, setFront] = useState(card?.front||"");
  const [back, setBack] = useState(card?.back||"");
  const [preview, setPreview] = useState(false);
  const ta = {width:"100%",background:t.bg,color:t.text,border:`1px solid ${t.border}`,borderRadius:6,padding:"10px 12px",fontFamily:t.fontBody,fontSize:13,resize:"vertical",minHeight:180,outline:"none",boxSizing:"border-box"};
  return (
    <div style={{padding:"1.5rem",maxWidth:700,margin:"0 auto"}}>
      <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center"}}>
        {["Edit","Preview"].map((l,i)=><button key={l} onClick={()=>setPreview(i===1)} style={{background:preview===(i===1)?t.accent:"transparent",color:preview===(i===1)?t.bg:t.muted,border:`1px solid ${t.border}`,borderRadius:4,padding:"4px 14px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>{l}</button>)}
        <span style={{marginLeft:"auto",fontSize:10,color:t.muted}}>## heading · **bold** · *italic* · `code` · - list · | table | · {">"} quote</span>
      </div>
      {preview ? (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          {[{label:"FRONT",content:front,bg:t.card},{label:"BACK",content:back,bg:t.cardBack}].map(({label,content,bg})=>(
            <div key={label} style={{background:bg,border:`1px solid ${t.border}`,borderRadius:8,padding:18}}>
              <div style={{fontSize:10,color:t.muted,marginBottom:8}}>{label}</div>
              <RichText content={content}/>
            </div>
          ))}
        </div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          {[{label:"FRONT",value:front,set:setFront,ph:"## Question\n\nWhat is the mechanism of...?"},{label:"BACK",value:back,set:setBack,ph:"## Answer\n\n- Key point\n- Another point"}].map(({label,value,set,ph})=>(
            <div key={label}><label style={{display:"block",fontSize:10,color:t.muted,marginBottom:5}}>{label}</label><textarea style={ta} value={value} onChange={e=>set(e.target.value)} placeholder={ph}/></div>
          ))}
        </div>
      )}
      <div style={{display:"flex",gap:10,marginTop:18,justifyContent:"flex-end"}}>
        <button onClick={onCancel} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"8px 20px",cursor:"pointer",fontFamily:t.fontBody}}>Cancel</button>
        <button onClick={()=>onSave({front,back})} style={{background:t.accent,color:t.bg,border:"none",borderRadius:6,padding:"8px 22px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700}}>Save Card</button>
      </div>
    </div>
  );
}

// ─── Deck Editor ──────────────────────────────────────────────────────────────
function DeckEditor({deck, onSave, onCancel, t}) {
  const [name, setName] = useState(deck?.name||"");
  const [desc, setDesc] = useState(deck?.description||"");
  const [color, setColor] = useState(deck?.color||"#2980b9");
  const [stems, setStems] = useState(deck?.stems||[""]);
  const [cards, setCards] = useState(deck?.cards||[]);
  const [editingCard, setEditingCard] = useState(null);
  const inp = {width:"100%",background:t.bg,color:t.text,border:`1px solid ${t.border}`,borderRadius:6,padding:"8px 12px",fontFamily:t.fontBody,fontSize:13,outline:"none",boxSizing:"border-box"};

  return (
    <div style={{padding:"1.5rem",maxWidth:820,margin:"0 auto"}}>
      {editingCard!==null ? (
        <>
          <button onClick={()=>setEditingCard(null)} style={{background:"transparent",color:t.accent,border:"none",cursor:"pointer",marginBottom:14,fontFamily:t.fontBody,fontSize:13}}>← Back to deck</button>
          <CardEditor card={editingCard==="new"?null:cards[editingCard]} onSave={data=>{if(editingCard==="new")setCards([...cards,{id:generateId(),...data,progress:null}]);else setCards(cards.map((c,i)=>i===editingCard?{...c,...data}:c));setEditingCard(null);}} onCancel={()=>setEditingCard(null)} t={t}/>
        </>
      ) : (
        <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:12,marginBottom:18}}>
            {[{l:"DECK NAME",v:name,s:setName,p:"e.g. Cardiology Cases"},{l:"DESCRIPTION",v:desc,s:setDesc,p:"Short description..."}].map(({l,v,s,p})=>(
              <div key={l}><label style={{display:"block",fontSize:10,color:t.muted,marginBottom:4}}>{l}</label><input style={inp} value={v} onChange={e=>s(e.target.value)} placeholder={p}/></div>
            ))}
            <div><label style={{display:"block",fontSize:10,color:t.muted,marginBottom:4}}>COLOUR</label><input type="color" value={color} onChange={e=>setColor(e.target.value)} style={{width:46,height:36,border:`1px solid ${t.border}`,borderRadius:6,cursor:"pointer",background:"none"}}/></div>
          </div>

          <div style={{marginBottom:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <label style={{fontSize:10,color:t.muted}}>CASE STEMS <span style={{opacity:0.6}}>(one randomly selected per session)</span></label>
              <button onClick={()=>setStems([...stems,""])} style={{background:"transparent",color:t.accent,border:`1px solid ${t.accent}`,borderRadius:4,padding:"3px 10px",cursor:"pointer",fontFamily:t.fontBody,fontSize:11}}>+ Add Stem</button>
            </div>
            {stems.map((s,i)=>(
              <div key={i} style={{display:"flex",gap:8,marginBottom:8}}>
                <textarea style={{...inp,minHeight:75,resize:"vertical",flex:1}} value={s} onChange={e=>setStems(stems.map((st,si)=>si===i?e.target.value:st))} placeholder={"Case stem "+(i+1)+"..."}/>
                {stems.length>1&&<button onClick={()=>setStems(stems.filter((_,si)=>si!==i))} style={{background:"transparent",color:"#e74c3c",border:"1px solid #e74c3c",borderRadius:4,padding:"4px 10px",cursor:"pointer",alignSelf:"flex-start",marginTop:2}}>x</button>}
              </div>
            ))}
          </div>

          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <label style={{fontSize:10,color:t.muted}}>{cards.length} CARDS</label>
              <button onClick={()=>setEditingCard("new")} style={{background:t.accent,color:t.bg,border:"none",borderRadius:6,padding:"6px 16px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700,fontSize:13}}>+ New Card</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {cards.map((card,i)=>(
                <div key={card.id} style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:12}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,color:t.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.front.replace(/^#+\s/,"").split("\n")[0]}</div>
                    <div style={{fontSize:11,color:t.muted,marginTop:2}}>{card.progress?"State: "+card.progress.state+" · Reps: "+card.progress.reps:"New card"}</div>
                  </div>
                  <button onClick={()=>setEditingCard(i)} style={{background:"transparent",color:t.accent,border:`1px solid ${t.border}`,borderRadius:4,padding:"4px 10px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>Edit</button>
                  <button onClick={()=>setCards(cards.filter((_,ci)=>ci!==i))} style={{background:"transparent",color:"#e74c3c",border:"1px solid #e74c3c40",borderRadius:4,padding:"4px 10px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>Del</button>
                </div>
              ))}
              {cards.length===0&&<div style={{textAlign:"center",color:t.muted,padding:"2rem",fontSize:13}}>No cards yet. Add your first card above.</div>}
            </div>
          </div>

          <div style={{display:"flex",gap:10,marginTop:22,justifyContent:"flex-end"}}>
            <button onClick={onCancel} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"8px 20px",cursor:"pointer",fontFamily:t.fontBody}}>Cancel</button>
            <button onClick={()=>onSave({name,description:desc,color,stems,cards})} disabled={!name} style={{background:t.accent,color:t.bg,border:"none",borderRadius:6,padding:"8px 24px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700}}>
              {deck?"Save Changes":"Create Deck"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Study Session ─────────────────────────────────────────────────────────────
function StudySession({decks, deckIds, mixedMode, onFinish, t, stemMode}) {
  const sessionDecks = decks.filter(d=>deckIds.includes(d.id));
  const allCards = mixedMode
    ? sessionDecks.flatMap(d=>{const stem=(d.stems||[])[Math.floor(Math.random()*(d.stems||[""]).length)]||"";return d.cards.map(c=>({...c,deckId:d.id,stem}));})
    : (()=>{const d=sessionDecks[0];const stem=(d.stems||[])[Math.floor(Math.random()*(d.stems||[""]).length)]||"";return d.cards.map(c=>({...c,deckId:d.id,stem}));})();

  const now = new Date();
  const dueCards = allCards.filter(c=>!c.progress||c.progress.state==="new"||!c.progress.reps||new Date(c.progress.due)<=now);

  const [queue] = useState(()=>[...dueCards].sort(()=>Math.random()-0.5));
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [stemVisible, setStemVisible] = useState(stemMode==="start");
  const [results, setResults] = useState([]);
  const [done, setDone] = useState(false);

  const current = queue[idx];

  const handleRate = (rating) => {
    const prog = current.progress || initCard();
    const newProg = fsrsSchedule(prog, rating);
    setResults(r=>[...r,{cardId:current.id,deckId:current.deckId,rating,newProg}]);
    if(idx+1>=queue.length){setDone(true);}
    else{setIdx(i=>i+1);setFlipped(false);setStemVisible(stemMode==="start");}
  };

  if(queue.length===0) return (
    <div style={{textAlign:"center",padding:"4rem 2rem"}}>
      <div style={{fontSize:46,marginBottom:14}}>🎉</div>
      <div style={{fontSize:22,fontFamily:t.fontDisplay,color:t.accent,marginBottom:8}}>All caught up!</div>
      <div style={{fontSize:13,color:t.muted,marginBottom:22}}>No cards due right now.</div>
      <button onClick={()=>onFinish([])} style={{background:t.accent,color:t.bg,border:"none",borderRadius:8,padding:"10px 28px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700}}>Back to Decks</button>
    </div>
  );

  if(done) return (
    <div style={{textAlign:"center",padding:"3rem 2rem",maxWidth:480,margin:"0 auto"}}>
      <div style={{fontSize:38,marginBottom:10}}>✓</div>
      <div style={{fontSize:22,fontFamily:t.fontDisplay,color:t.accent,marginBottom:6}}>Session Complete</div>
      <div style={{fontSize:13,color:t.muted,marginBottom:22}}>{results.length} cards reviewed</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:26}}>
        {[{r:1,l:"Again",c:"#e74c3c"},{r:2,l:"Hard",c:"#e67e22"},{r:3,l:"Good",c:"#2ecc71"},{r:4,l:"Easy",c:"#3498db"}].map(({r,l,c})=>(
          <div key={r} style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:8,padding:"12px 6px"}}>
            <div style={{fontSize:22,fontWeight:800,color:c,fontFamily:t.fontDisplay}}>{results.filter(res=>res.rating===r).length}</div>
            <div style={{fontSize:11,color:t.muted,marginTop:3}}>{l}</div>
          </div>
        ))}
      </div>
      <button onClick={()=>onFinish(results)} style={{background:t.accent,color:t.bg,border:"none",borderRadius:8,padding:"10px 28px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700}}>Finish</button>
    </div>
  );

  const showStemToggle = !stemVisible && stemMode==="withCards";

  return (
    <div style={{maxWidth:700,margin:"0 auto",padding:"1rem 1rem 2.5rem"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <div style={{flex:1,height:4,background:t.border,borderRadius:2}}>
          <div style={{width:`${(idx/Math.max(queue.length,1))*100}%`,height:"100%",background:t.accent,borderRadius:2,transition:"width 0.3s"}}/>
        </div>
        <span style={{fontSize:12,color:t.muted,fontFamily:t.fontBody,minWidth:55,textAlign:"right"}}>{idx}/{queue.length}</span>
      </div>

      {stemVisible && current?.stem && (
        <div style={{background:t.surface,border:`1px solid ${t.accent}40`,borderLeft:`3px solid ${t.accent}`,borderRadius:10,padding:"13px 16px",marginBottom:16,fontSize:13,lineHeight:1.65,color:t.text}}>
          <div style={{fontSize:10,color:t.accent,marginBottom:7,letterSpacing:"0.1em"}}>CLINICAL SCENARIO</div>
          {current.stem}
        </div>
      )}
      {showStemToggle && <button onClick={()=>setStemVisible(true)} style={{background:"transparent",color:t.accent,border:`1px dashed ${t.accent}60`,borderRadius:6,padding:"5px 14px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12,marginBottom:12,display:"block"}}>Show case stem</button>}

      <div style={{perspective:1000}} onClick={()=>!flipped&&setFlipped(true)}>
        <div style={{position:"relative",minHeight:280,transformStyle:"preserve-3d",transition:"transform 0.5s cubic-bezier(0.4,0,0.2,1)",transform:flipped?"rotateY(180deg)":"rotateY(0deg)",cursor:flipped?"default":"pointer"}}>
          <div style={{position:"absolute",width:"100%",minHeight:280,backfaceVisibility:"hidden",WebkitBackfaceVisibility:"hidden",background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:"26px 26px 22px",boxSizing:"border-box"}}>
            {!flipped&&<div style={{position:"absolute",bottom:14,left:"50%",transform:"translateX(-50%)",fontSize:10,color:t.muted,letterSpacing:"0.1em"}}>CLICK TO REVEAL</div>}
            <RichText content={current?.front}/>
          </div>
          <div style={{position:"absolute",width:"100%",minHeight:280,backfaceVisibility:"hidden",WebkitBackfaceVisibility:"hidden",transform:"rotateY(180deg)",background:t.cardBack,border:`1px solid ${t.accent}40`,borderRadius:16,padding:"26px 26px 22px",boxSizing:"border-box"}}>
            <div style={{fontSize:10,color:t.accent,marginBottom:10,letterSpacing:"0.1em"}}>ANSWER</div>
            <RichText content={current?.back}/>
          </div>
        </div>
      </div>

      {flipped && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10,marginTop:20}}>
          {[{r:1,l:"Again",s:"<1d",c:"#e74c3c"},{r:2,l:"Hard",s:"~1d",c:"#e67e22"},{r:3,l:"Good",s:"~3d",c:"#2ecc71"},{r:4,l:"Easy",s:"~1w",c:"#3498db"}].map(({r,l,s,c})=>(
            <button key={r} onClick={()=>handleRate(r)} style={{background:c+"18",color:c,border:`1px solid ${c}40`,borderRadius:10,padding:"11px 6px",cursor:"pointer",fontFamily:t.fontBody,fontSize:14,fontWeight:700}}>
              {l}<br/><span style={{fontSize:10,opacity:0.7,fontWeight:400}}>{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Share Modal ──────────────────────────────────────────────────────────────
function ShareModal({deck, t, onClose, onToggle}) {
  const shareUrl = deck.shared ? window.location.origin+window.location.pathname+"?import="+deck.share_token : null;
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(()=>setCopied(false),2000); };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:"1rem"}} onClick={onClose}>
      <div style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:14,padding:"1.5rem",maxWidth:480,width:"100%"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:t.fontDisplay,fontWeight:700,fontSize:16,marginBottom:6}}>Share "{deck.name}"</div>
        <div style={{fontSize:13,color:t.muted,marginBottom:18}}>Anyone with the link can import a read-only copy. Progress is tracked separately per user.</div>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
          <span style={{fontSize:13}}>Enable sharing</span>
          <div onClick={onToggle} style={{width:44,height:24,borderRadius:12,border:`1px solid ${t.border}`,background:deck.shared?t.accent:t.border,cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
            <div style={{position:"absolute",top:3,left:deck.shared?22:3,width:16,height:16,borderRadius:"50%",background:deck.shared?t.bg:"#fff",transition:"left 0.2s"}}/>
          </div>
        </div>
        {deck.shared && shareUrl && (
          <div style={{background:t.bg,border:`1px solid ${t.border}`,borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <span style={{flex:1,fontSize:11,color:t.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shareUrl}</span>
            <button onClick={copy} style={{background:t.accent,color:t.bg,border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12,fontWeight:700,flexShrink:0}}>{copied?"Copied!":"Copy"}</button>
          </div>
        )}
        <button onClick={onClose} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"7px 20px",cursor:"pointer",fontFamily:t.fontBody,fontSize:13}}>Close</button>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function StudyDecks() {
  const [themeKey, setThemeKey] = useState("retro");
  const t = THEMES[themeKey];
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(()=>getSession());
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState("home");
  const [activeDeckIds, setActiveDeckIds] = useState([]);
  const [mixedMode, setMixedMode] = useState(false);
  const [stemMode, setStemMode] = useState("start");
  const [editingDeck, setEditingDeck] = useState(null);
  const [shareModal, setShareModal] = useState(null);
  const [importMsg, setImportMsg] = useState(null);

  useEffect(() => {
    const s = getSession();
    if (s?.user) setUser(s.user);
    const params = new URLSearchParams(window.location.search);
    const importToken = params.get("import");
    if (importToken) handleImport(importToken);
  }, []);

  useEffect(() => { if (session) loadDecks(); }, [session]);

  const loadDecks = async () => {
    setLoading(true);
    try {
      const rawDecks = await sbFetch("decks?select=*&order=created_at.asc");
      const rawCards = await sbFetch("cards?select=*&order=position.asc");
      const rawProgress = await sbFetch("card_progress?select=*");
      const progressMap = {};
      for (const p of rawProgress) progressMap[p.card_id] = p;
      const deckMap = {};
      for (const d of rawDecks) deckMap[d.id] = { ...d, cards: [] };
      for (const c of rawCards) { if (deckMap[c.deck_id]) deckMap[c.deck_id].cards.push({ ...c, progress: progressMap[c.id]||null }); }
      setDecks(Object.values(deckMap));
    } catch(e) { console.error("Load error:", e); }
    setLoading(false);
  };

  const saveDeck = async (data, existingDeck) => {
    setSyncing(true);
    try {
      const userId = user?.id || session?.user?.id;
      if (existingDeck) {
        await sbFetch("decks?id=eq."+existingDeck.id, { method:"PATCH", body:JSON.stringify({name:data.name,description:data.description,color:data.color,stems:data.stems,updated_at:new Date().toISOString()}) });
        for (let i=0;i<data.cards.length;i++) {
          const card = data.cards[i];
          const isNew = !existingDeck.cards.find(c=>c.id===card.id);
          if (isNew) await sbFetch("cards", {method:"POST",body:JSON.stringify({deck_id:existingDeck.id,user_id:userId,front:card.front,back:card.back,position:i})});
          else await sbFetch("cards?id=eq."+card.id, {method:"PATCH",body:JSON.stringify({front:card.front,back:card.back,position:i,updated_at:new Date().toISOString()})});
        }
        for (const oldCard of existingDeck.cards) {
          if (!data.cards.find(c=>c.id===oldCard.id)) await sbFetch("cards?id=eq."+oldCard.id, {method:"DELETE"});
        }
      } else {
        const [newDeck] = await sbFetch("decks?select=*", {method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({user_id:userId,name:data.name,description:data.description,color:data.color,stems:data.stems})});
        for (let i=0;i<data.cards.length;i++) {
          await sbFetch("cards", {method:"POST",body:JSON.stringify({deck_id:newDeck.id,user_id:userId,front:data.cards[i].front,back:data.cards[i].back,position:i})});
        }
      }
      await loadDecks();
    } catch(e) { alert("Save failed: "+e.message); }
    setSyncing(false);
  };

  const deleteDeck = async (deckId) => {
    if (!confirm("Delete this deck? This cannot be undone.")) return;
    setSyncing(true);
    try { await sbFetch("decks?id=eq."+deckId, {method:"DELETE"}); setDecks(prev=>prev.filter(d=>d.id!==deckId)); }
    catch(e) { alert("Delete failed: "+e.message); }
    setSyncing(false);
  };

  const handleStudyFinish = async (results) => {
    setView("home");
    if (!results.length) return;
    setSyncing(true);
    try {
      const userId = user?.id || session?.user?.id;
      for (const res of results) {
        const p = res.newProg;
        await sbFetch("card_progress", {method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({user_id:userId,card_id:res.cardId,stability:p.stability,difficulty:p.difficulty,elapsed_days:p.elapsed_days,scheduled_days:p.scheduled_days,reps:p.reps,lapses:p.lapses,state:p.state,last_review:p.last_review,due:p.due,updated_at:new Date().toISOString()})});
      }
      await loadDecks();
    } catch(e) { console.error("Progress save error:", e); }
    setSyncing(false);
  };

  const toggleShare = async (deck) => {
    setSyncing(true);
    try {
      await sbFetch("decks?id=eq."+deck.id, {method:"PATCH",body:JSON.stringify({shared:!deck.shared})});
      setDecks(prev=>prev.map(d=>d.id===deck.id?{...d,shared:!d.shared}:d));
      setShareModal(prev=>prev?{...prev,shared:!prev.shared}:null);
    } catch(e) { alert("Failed: "+e.message); }
    setSyncing(false);
  };

  const handleImport = async (token) => {
    try {
      const results = await sbFetch("decks?share_token=eq."+token+"&shared=eq.true&select=*");
      if (!results||!results.length) { setImportMsg("Deck not found or sharing has been disabled."); return; }
      const sharedDeck = results[0];
      const sharedCards = await sbFetch("cards?deck_id=eq."+sharedDeck.id+"&select=*");
      setImportMsg({deck:sharedDeck,cards:sharedCards,token});
    } catch(e) { setImportMsg("Could not load shared deck."); }
  };

  const confirmImport = async () => {
    if (!session||!importMsg?.deck) return;
    const userId = user?.id||session?.user?.id;
    setSyncing(true);
    try {
      const [newDeck] = await sbFetch("decks?select=*", {method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({user_id:userId,name:importMsg.deck.name+" (imported)",description:importMsg.deck.description,color:importMsg.deck.color,stems:importMsg.deck.stems})});
      for (let i=0;i<importMsg.cards.length;i++) {
        const c=importMsg.cards[i];
        await sbFetch("cards", {method:"POST",body:JSON.stringify({deck_id:newDeck.id,user_id:userId,front:c.front,back:c.back,position:i})});
      }
      setImportMsg(null); window.history.replaceState({},"",window.location.pathname);
      await loadDecks();
    } catch(e) { alert("Import failed: "+e.message); }
    setSyncing(false);
  };

  const signOut = async () => {
    try { await fetch(SUPABASE_URL+"/auth/v1/logout", {method:"POST",headers:{apikey:SUPABASE_ANON_KEY,Authorization:"Bearer "+(session?.access_token||"")}}); } catch{}
    saveSession(null); setUser(null); setSession(null); setDecks([]);
  };

  if (!session) return (
    <div>
      <AuthScreen t={t} onAuth={(u,s)=>{saveSession(s);setUser(u);setSession(s);}}/>
    </div>
  );

  const totalStats = {decks:decks.length,cards:decks.reduce((a,d)=>a+d.cards.length,0),due:decks.reduce((a,d)=>a+getDueCards(d).length,0),learned:decks.reduce((a,d)=>a+d.cards.filter(c=>c.progress?.state==="review").length,0)};

  return (
    <div style={{minHeight:"100vh",background:t.bg,color:t.text,fontFamily:t.fontBody}}>
      {t.scanlines&&<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.03) 2px,rgba(0,0,0,0.03) 4px)",pointerEvents:"none",zIndex:999}}/>}

      {importMsg&&session&&typeof importMsg==="object"&&importMsg.deck&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:"1rem"}}>
          <div style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:14,padding:"1.5rem",maxWidth:440,width:"100%",textAlign:"center"}}>
            <div style={{fontSize:16,fontFamily:t.fontDisplay,fontWeight:700,marginBottom:8}}>Import Deck?</div>
            <div style={{fontSize:13,color:t.muted,marginBottom:18}}>Import "<strong style={{color:t.text}}>{importMsg.deck.name}</strong>" with {importMsg.cards.length} cards? You will get your own copy with separate progress tracking.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={()=>{setImportMsg(null);window.history.replaceState({},"",window.location.pathname);}} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"8px 20px",cursor:"pointer",fontFamily:t.fontBody}}>Cancel</button>
              <button onClick={confirmImport} style={{background:t.accent,color:t.bg,border:"none",borderRadius:6,padding:"8px 22px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700}}>Import Deck</button>
            </div>
          </div>
        </div>
      )}
      {typeof importMsg==="string"&&<div style={{background:"#e74c3c20",border:"1px solid #e74c3c50",padding:"10px 18px",color:"#e74c3c",fontSize:13,textAlign:"center"}}>{importMsg} <button onClick={()=>setImportMsg(null)} style={{background:"transparent",border:"none",color:"#e74c3c",cursor:"pointer",marginLeft:8}}>x</button></div>}

      {shareModal&&<ShareModal deck={shareModal} t={t} onClose={()=>setShareModal(null)} onToggle={()=>toggleShare(shareModal)}/>}

      <header style={{background:t.surface,borderBottom:`1px solid ${t.border}`,padding:"0 1.5rem",position:"sticky",top:0,zIndex:100,display:"flex",alignItems:"center",height:54}}>
        <button onClick={()=>setView("home")} style={{background:"transparent",border:"none",cursor:"pointer",padding:0}}>
          <span style={{fontSize:17,fontFamily:t.fontDisplay,fontWeight:800,color:t.accent,letterSpacing:t.scanlines?"0.07em":"0"}}>{t.scanlines?"STUDY_DECKS":"Study Decks"}</span>
        </button>
        {syncing&&<span style={{marginLeft:12,fontSize:11,color:t.muted}}>syncing...</span>}
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          {view==="home"&&<>
            <button onClick={()=>{setMixedMode(true);setActiveDeckIds(decks.map(d=>d.id));setView("study");}} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 12px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>Mixed</button>
            <button onClick={()=>setView("stats")} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 12px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>Stats</button>
          </>}
          <select value={themeKey} onChange={e=>setThemeKey(e.target.value)} style={{background:t.surface,color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 8px",fontFamily:t.fontBody,fontSize:11,cursor:"pointer",outline:"none"}}>
            {Object.entries(THEMES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
          </select>
          <button onClick={signOut} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 12px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>Sign out</button>
        </div>
      </header>

      {view==="study"&&<StudySession decks={decks} deckIds={activeDeckIds} mixedMode={mixedMode} onFinish={handleStudyFinish} t={t} stemMode={stemMode}/>}

      {(view==="edit-deck"||view==="new-deck")&&(
        <DeckEditor deck={editingDeck} onSave={async(data)=>{await saveDeck(data,editingDeck);setEditingDeck(null);setView("home");}} onCancel={()=>{setEditingDeck(null);setView("home");}} t={t}/>
      )}

      {view==="stats"&&(
        <div style={{padding:"2rem 1.5rem",maxWidth:700,margin:"0 auto"}}>
          <h2 style={{fontFamily:t.fontDisplay,color:t.accent,marginBottom:22,fontSize:18}}>Progress Overview</h2>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:26}}>
            {[{l:"Total Decks",v:totalStats.decks},{l:"Total Cards",v:totalStats.cards},{l:"Cards Due",v:totalStats.due,hi:totalStats.due>0},{l:"Cards Learned",v:totalStats.learned}].map(({l,v,hi})=>(
              <div key={l} style={{background:t.surface,border:`1px solid ${hi?t.accent:t.border}`,borderRadius:10,padding:"16px 20px"}}>
                <div style={{fontSize:11,color:t.muted,marginBottom:5}}>{l}</div>
                <div style={{fontSize:28,fontWeight:800,fontFamily:t.fontDisplay,color:hi?t.accent:t.text}}>{v}</div>
              </div>
            ))}
          </div>
          {decks.map(d=>{const s=deckStats(d);return(
            <div key={d.id} style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:10,padding:"14px 18px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:9}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:d.color}}/>
                <span style={{fontWeight:700,fontFamily:t.fontDisplay}}>{d.name}</span>
                <span style={{marginLeft:"auto",fontSize:12,color:t.muted}}>{s.total} cards</span>
              </div>
              <div style={{height:5,background:t.border,borderRadius:3,overflow:"hidden",marginBottom:8}}>
                <div style={{height:"100%",width:`${(s.learned/Math.max(s.total,1))*100}%`,background:d.color,borderRadius:3}}/>
              </div>
              <div style={{display:"flex",gap:14,fontSize:11,color:t.muted}}>
                <span>{s.newCards} new</span><span>{s.due} due</span><span>{s.learned} learned</span>
              </div>
            </div>
          );})}
          <button onClick={()=>setView("home")} style={{marginTop:14,background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:6,padding:"8px 20px",cursor:"pointer",fontFamily:t.fontBody}}>Back</button>
        </div>
      )}

      {view==="home"&&(
        <div style={{padding:"1.5rem",maxWidth:820,margin:"0 auto"}}>
          <div style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:10,padding:"10px 16px",marginBottom:18,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:t.muted}}>Case stem:</span>
            {[{v:"start",l:"Show at start"},{v:"withCards",l:"With cards"},{v:"hide",l:"Hide"}].map(({v,l})=>(
              <button key={v} onClick={()=>setStemMode(v)} style={{background:stemMode===v?t.accent:"transparent",color:stemMode===v?t.bg:t.muted,border:`1px solid ${stemMode===v?t.accent:t.border}`,borderRadius:6,padding:"4px 12px",cursor:"pointer",fontFamily:t.fontBody,fontSize:12}}>{l}</button>
            ))}
          </div>

          {loading&&<div style={{textAlign:"center",padding:"3rem",color:t.muted,fontSize:13}}>Loading your decks...</div>}

          {!loading&&totalStats.due>0&&(
            <div style={{background:t.accent+"10",border:`1px solid ${t.accent}30`,borderRadius:10,padding:"13px 18px",marginBottom:18,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <span style={{color:t.accent,fontSize:13}}><strong>{totalStats.due}</strong> cards due across all decks</span>
              <button onClick={()=>{setMixedMode(true);setActiveDeckIds(decks.map(d=>d.id));setView("study");}} style={{background:t.accent,color:t.bg,border:"none",borderRadius:6,padding:"6px 16px",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700,fontSize:13}}>Study All Due</button>
            </div>
          )}

          {!loading&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))",gap:14}}>
              {decks.map(deck=>{
                const s=deckStats(deck);
                return(
                  <div key={deck.id} style={{background:t.surface,border:`1px solid ${t.border}`,borderRadius:12,overflow:"hidden",display:"flex",flexDirection:"column"}}>
                    <div style={{height:4,background:deck.color}}/>
                    <div style={{padding:"15px 17px",flex:1}}>
                      <div style={{fontFamily:t.fontDisplay,fontWeight:700,fontSize:15,marginBottom:3}}>{deck.name}</div>
                      <div style={{fontSize:12,color:t.muted,marginBottom:11}}>{deck.description}</div>
                      <div style={{display:"flex",gap:12,fontSize:12,color:t.muted,marginBottom:12}}>
                        <span>{s.total} cards</span>
                        <span style={{color:s.due>0?t.accent:t.muted}}>{s.due} due</span>
                        <span>{s.learned} learned</span>
                        {deck.shared&&<span style={{color:t.accentAlt}}>shared</span>}
                      </div>
                      <div style={{height:3,background:t.border,borderRadius:2,marginBottom:13}}>
                        <div style={{height:"100%",width:`${(s.learned/Math.max(s.total,1))*100}%`,background:deck.color,borderRadius:2}}/>
                      </div>
                      <div style={{display:"flex",gap:7}}>
                        <button onClick={()=>{setActiveDeckIds([deck.id]);setMixedMode(false);setView("study");}} style={{flex:1,background:s.due>0?t.accent:t.accent+"30",color:s.due>0?t.bg:t.muted,border:"none",borderRadius:7,padding:"8px 0",cursor:"pointer",fontFamily:t.fontBody,fontWeight:700,fontSize:13}}>
                          {s.due>0?"Study ("+s.due+")":"All done"}
                        </button>
                        <button onClick={()=>setShareModal(deck)} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:7,padding:"8px 10px",cursor:"pointer",fontSize:13}} title="Share">Link</button>
                        <button onClick={()=>{setEditingDeck(deck);setView("edit-deck");}} style={{background:"transparent",color:t.muted,border:`1px solid ${t.border}`,borderRadius:7,padding:"8px 10px",cursor:"pointer",fontSize:13}}>Edit</button>
                        <button onClick={()=>deleteDeck(deck.id)} style={{background:"transparent",color:"#e74c3c60",border:"1px solid #e74c3c30",borderRadius:7,padding:"8px 10px",cursor:"pointer",fontSize:13}}>Del</button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button onClick={()=>{setEditingDeck(null);setView("new-deck");}} style={{background:"transparent",border:`2px dashed ${t.border}`,borderRadius:12,padding:"2rem",cursor:"pointer",color:t.muted,fontFamily:t.fontBody,fontSize:14,display:"flex",flexDirection:"column",alignItems:"center",gap:8,minHeight:150}} onMouseEnter={e=>{e.currentTarget.style.borderColor=t.accent;e.currentTarget.style.color=t.accent;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=t.border;e.currentTarget.style.color=t.muted;}}>
                <span style={{fontSize:26}}>+</span><span>New Deck</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
