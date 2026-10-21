from pathlib import Path
p=Path('/mnt/data/vq41/backend/server.js')
s=p.read_text()
start=s.index('// VaultQ AI: account-aware financial copilot.')
end=s.index('app.get("/api/health"', start)
new=r'''// VaultQ AI: account-aware financial copilot.
// Priority: OpenAI (if configured) -> local Ollama (if installed) -> VaultQ reasoning engine.
// No API key is required for the last two modes.
function getAiContext(uid){
  const inv=db.prepare("SELECT asset_name,symbol,asset_type,quantity,buy_price,current_price FROM investments WHERE user_id=? ORDER BY current_price*quantity DESC").all(uid);
  const expenses=db.prepare("SELECT category,COALESCE(SUM(amount),0) amount FROM expenses WHERE user_id=? GROUP BY category ORDER BY amount DESC").all(uid);
  const goals=db.prepare("SELECT name,target_amount,current_amount,target_date FROM goals WHERE user_id=? ORDER BY target_date IS NULL,target_date").all(uid);
  const bank=db.prepare("SELECT direction,category,description,transaction_date,COALESCE(amount,0) amount FROM bank_transactions WHERE user_id=? ORDER BY transaction_date DESC LIMIT 80").all(uid);
  const cash=db.prepare("SELECT cash_balance FROM users WHERE id=?").get(uid)?.cash_balance||0;
  const current=inv.reduce((a,x)=>a+Number(x.current_price||x.buy_price||0)*Number(x.quantity||0),0);
  const invested=inv.reduce((a,x)=>a+Number(x.buy_price||0)*Number(x.quantity||0),0);
  const income=bank.filter(x=>x.direction==='CREDIT').reduce((a,x)=>a+Number(x.amount||0),0);
  const spending=bank.filter(x=>x.direction==='DEBIT').reduce((a,x)=>a+Number(x.amount||0),0);
  const expenseTotal=expenses.reduce((a,x)=>a+Number(x.amount||0),0);
  const allocation=inv.reduce((m,x)=>{const k=x.asset_type||'Other';m[k]=(m[k]||0)+Number(x.current_price||x.buy_price||0)*Number(x.quantity||0);return m},{});
  const topHolding=inv[0]||null;
  const topHoldingValue=topHolding?Number(topHolding.current_price||topHolding.buy_price||0)*Number(topHolding.quantity||0):0;
  const savingsRate=income>0?((income-spending)/income)*100:null;
  const goalsDetailed=goals.map(g=>({
    ...g,
    progress:Number(g.target_amount)>0?(Number(g.current_amount)/Number(g.target_amount))*100:0,
    remaining:Math.max(0,Number(g.target_amount)-Number(g.current_amount))
  }));
  const categorySpend={};
  bank.filter(x=>x.direction==='DEBIT').forEach(x=>{const k=x.category||'Other';categorySpend[k]=(categorySpend[k]||0)+Number(x.amount||0)});
  return {inv,expenses,goals:goalsDetailed,bank,cash,current,invested,profit:current-invested,returnPct:invested?((current-invested)/invested)*100:0,income,spending,expenseTotal,allocation,topHolding,topHoldingValue,savingsRate,categorySpend};
}
function aiContextForModel(c){
  return JSON.stringify({
    portfolio:{current:c.current,invested:c.invested,profit:c.profit,returnPct:c.returnPct,holdings:c.inv},
    allocation:c.allocation,expenses:c.expenses,expenseTotal:c.expenseTotal,goals:c.goals,
    bankFlow:{credits:c.income,debits:c.spending},cash:c.cash,categorySpend:c.categorySpend,
    recentBankTransactions:c.bank.slice(0,30)
  });
}
function words(q){return String(q||'').toLowerCase().replace(/[^a-z0-9₹.% ]/g,' ').split(/\s+/).filter(Boolean)}
function hasAny(q,list){return list.some(x=>q.includes(x))}
function localAiAnswer(question,c){
  const q=String(question||'').toLowerCase().trim();
  const total=Math.max(c.current,1);
  const top=c.topHolding;
  const holdingValue=top?c.topHoldingValue:0;
  const concentration=top?(holdingValue/total)*100:0;
  const allocation=Object.entries(c.allocation).sort((a,b)=>b[1]-a[1]);
  const topSpend=Object.entries(c.categorySpend).sort((a,b)=>b[1]-a[1]);
  const goal=c.goals.slice().sort((a,b)=>a.remaining-b.remaining)[0];

  if(!q) return 'Tell me what you want to understand and I will work it out from your VaultQ data.';
  if(hasAny(q,['hello','hi','hey','good morning','good evening'])) return `Hi! I’m VaultQ AI. I can reason through your portfolio, spending, cash flow and goals. Your tracked portfolio is ${serverMoney(c.current)} across ${c.inv.length} holdings. What would you like to explore?`;

  if(hasAny(q,['profit','return','performance','gain','loss'])){
    const direction=c.profit>=0?'profit':'loss';
    return `Here’s the portfolio snapshot: **${serverMoney(c.current)}** current tracked value versus **${serverMoney(c.invested)}** invested, giving you a **${serverMoney(Math.abs(c.profit))} ${direction}** (${serverPct(c.returnPct)}).\n\nThis is calculated from the prices stored in VaultQ, so it is not the same as a guaranteed live market valuation. If you want, ask me why the result changed or whether your allocation is driving the risk.`;
  }
  if(hasAny(q,['divers','allocation','concentrat','overweight','underweight'])){
    if(!c.inv.length)return 'There are no tracked investments yet. Add holdings first and I can analyze concentration and asset allocation.';
    const lines=allocation.map(([k,v])=>`• ${k}: ${(v/total*100).toFixed(1)}%`).join('\n');
    const risk=concentration>=50?`Your largest holding is about ${concentration.toFixed(1)}% of the tracked portfolio, which is a significant concentration.`:concentration>=30?`Your largest holding is about ${concentration.toFixed(1)}%, so concentration is worth keeping an eye on.`:`No single holding dominates the tracked portfolio at the moment.`;
    return `Your tracked allocation is:\n${lines}\n\n${risk}\n\nDiversification is not just the number of holdings. Asset type, correlation, liquidity and your personal risk tolerance matter too.`;
  }
  if(hasAny(q,['expense','spend','spending','cost','where am i spending'])){
    if(!topSpend.length)return 'I do not have recorded spending categories yet. Import a bank statement or add expenses to unlock spending analysis.';
    const lines=topSpend.slice(0,5).map(([k,v],i)=>`${i+1}. ${k}: ${serverMoney(v)}`).join('\n');
    const pct=c.spending?((topSpend[0][1]/c.spending)*100):0;
    return `Your biggest recorded spending categories are:\n${lines}\n\n${topSpend[0][0]} is the largest at about ${pct.toFixed(1)}% of recorded bank debits. Total recorded expense entries are ${serverMoney(c.expenseTotal)}.\n\nA useful next step is to separate essential spending from discretionary spending before cutting anything.`;
  }
  if(hasAny(q,['cash flow','cashflow','income','salary','debit','credit','saving rate','savings rate'])){
    const net=c.income-c.spending;
    const rate=c.savingsRate===null?null:c.savingsRate;
    return `Recorded bank flow: **${serverMoney(c.income)}** in credits and **${serverMoney(c.spending)}** in debits, for a net of **${serverMoney(net)}**. ${rate===null?'I cannot calculate a savings rate because there is no recorded credit total.':`That gives a simple recorded savings rate of about **${rate.toFixed(1)}%**.`}\n\nThis is based on imported bank transactions available in VaultQ, not a full accounting of every account you may own.`;
  }
  if(hasAny(q,['goal','target','saving for','milestone','deadline'])){
    if(!c.goals.length)return 'You do not have a financial goal yet. Open Financial Goals and add a target. Once it exists, I can calculate progress, remaining amount and priority.';
    const lines=c.goals.map(g=>`• ${g.name}: ${Number(g.progress).toFixed(1)}% complete, ${serverMoney(g.remaining)} remaining${g.target_date?`, target ${g.target_date}`:''}`).join('\n');
    return `Here is your goal picture:\n${lines}\n\nThe closest remaining gap is **${goal.name}**, with **${serverMoney(goal.remaining)}** left. A good planning question is how much you can contribute regularly without weakening your cash buffer.`;
  }
  if(hasAny(q,['recommend','advice','what should i','what should i do','next step','review first','priority'])){
    const actions=[];
    if(!c.inv.length) actions.push('Add your main investments so portfolio analysis becomes meaningful.');
    if(concentration>=40) actions.push(`Review ${top.asset_name}, which represents roughly ${concentration.toFixed(1)}% of tracked portfolio value.`);
    if(topSpend.length) actions.push(`Review ${topSpend[0][0]} spending, currently your largest recorded category at ${serverMoney(topSpend[0][1])}.`);
    if(c.goals.length && goal.remaining>0) actions.push(`Keep ${goal.name} visible and set a sustainable contribution toward its ${serverMoney(goal.remaining)} remaining gap.`);
    if(c.cash<0) actions.push('Your available cash is negative in VaultQ, so liquidity deserves immediate attention.');
    if(!actions.length) actions.push('Review portfolio concentration, monthly spending and goal progress together rather than optimizing only one number.');
    return `Based on the information VaultQ currently has, I would review these in order:\n${actions.slice(0,4).map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\nI’m giving you a data-based checklist, not a guaranteed investment recommendation.`;
  }
  if(hasAny(q,['bank','fd','fixed deposit','interest rate','savings account'])) return 'Use Bank Comparison to compare the available bank-rate dataset. I can help you evaluate savings rate, one-year FD rate, peak FD rate and trade-offs, but the bank’s official terms should always be treated as final.';
  if(hasAny(q,['market','nifty','sensex','gold','silver','bitcoin','crypto'])) return 'Open Market for the latest available NIFTY 50, Sensex, gold, silver and Bitcoin data. Public market feeds can be delayed, especially around exchange closures.';
  if(hasAny(q,['sip','emi','calculator','fixed deposit maturity'])) return 'Use Calculators for SIP, EMI and FD scenarios. If you give me the amount, rate and period, I can also explain what the result means.';
  if(hasAny(q,['how much','what is my','show me','tell me'])){
    return `I can answer from your current VaultQ data. At the moment I see ${c.inv.length} holdings, ${serverMoney(c.current)} tracked portfolio value, ${serverMoney(c.cash)} available cash, ${serverMoney(c.expenseTotal)} recorded expenses and ${c.goals.length} financial goals. Ask a more specific question and I’ll break it down.`;
  }
  return `I can reason about your VaultQ data rather than just giving generic finance definitions. Try asking:\n• “Why is my portfolio concentrated?”\n• “Where am I spending the most?”\n• “Can I improve my savings rate?”\n• “Which goal should I prioritize?”\n• “What should I review first?”`;
}
async function ollamaAnswer(question,c,history=[]){
  const host=process.env.OLLAMA_HOST||'http://127.0.0.1:11434';
  const model=process.env.OLLAMA_MODEL||'mistral';
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),45000);
  try{
    const safeHistory=Array.isArray(history)?history.slice(-10).map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,3000)})).filter(x=>x.content):[];
    const system=`You are VaultQ AI, a practical personal-finance copilot. Use ONLY the supplied VaultQ account context for personal numbers. Never invent balances, holdings or rates. Explain reasoning clearly, use Indian rupee formatting when useful, and distinguish stored portfolio prices from live prices. Give educational analysis, not guaranteed returns or regulated advice. If the user asks for something unrelated, answer briefly and steer back when appropriate.\n\nVaultQ context:\n${aiContextForModel(c)}`;
    const messages=[{role:'system',content:system},...safeHistory,{role:'user',content:String(question).slice(0,5000)}];
    const r=await fetch(`${host.replace(/\/$/,'')}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,stream:false,options:{temperature:0.35}}),signal:controller.signal});
    if(!r.ok) throw new Error(`Ollama returned ${r.status}`);
    const d=await r.json(); const answer=String(d?.message?.content||'').trim(); if(!answer) throw new Error('Ollama returned an empty answer.');
    return answer;
  }finally{clearTimeout(timer)}
}
async function openAiAnswer(question,c,history=[]){
  const key=process.env.OPENAI_API_KEY; if(!key)return null;
  const model=process.env.OPENAI_MODEL||'gpt-6-luna';
  const safeHistory=Array.isArray(history)?history.slice(-12).map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,4000)})).filter(x=>x.content):[];
  const instructions=`You are VaultQ AI, an intelligent personal-finance copilot inside a student-built finance management application. Use the user's VaultQ data below as your primary source for personal-account questions. Be conversational, precise and transparent. Explain calculations when useful. Never invent account values. If data is missing, say so. For investment questions, provide educational analysis rather than guaranteed returns or regulated financial advice. Distinguish stored portfolio prices from live market prices. For bank rates, say official bank terms are authoritative. Keep answers concise but genuinely useful.\n\nVaultQ account context:\n${aiContextForModel(c)}`;
  const input=[...safeHistory,{role:'user',content:String(question).slice(0,5000)}];
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model,instructions,input,max_output_tokens:900})});
  if(!response.ok){const text=await response.text();throw new Error(`OpenAI API error ${response.status}: ${text.slice(0,240)}`)}
  const data=await response.json(); const answer=String(data.output_text||'').trim(); if(!answer)throw new Error('OpenAI returned an empty answer.'); return answer;
}
async function aiProvider(){
  if(process.env.OPENAI_API_KEY)return {provider:'OpenAI',model:process.env.OPENAI_MODEL||'gpt-6-luna',connected:true};
  try{
    const host=process.env.OLLAMA_HOST||'http://127.0.0.1:11434';
    const r=await fetch(`${host.replace(/\/$/,'')}/api/tags`); if(r.ok){const d=await r.json();const names=(d.models||[]).map(x=>x.name);const wanted=process.env.OLLAMA_MODEL||'mistral';const model=names.find(n=>n===wanted)||names.find(n=>n.startsWith(wanted+':'))||names[0];if(model)return {provider:'Ollama',model,connected:true};}
  }catch{}
  return {provider:'VaultQ Local AI',model:'VaultQ Reasoning Engine',connected:true};
}
app.get('/api/ai/status',requireAuth,async(req,res)=>res.json(await aiProvider()));
app.get('/api/ai/brief',requireAuth,async(req,res)=>{
  const c=getAiContext(req.session.userId); const top=c.topHolding; const brief=[];
  brief.push({title:'Portfolio',text:c.inv.length?`${serverMoney(c.current)} tracked across ${c.inv.length} holdings, ${serverPct(c.returnPct)} overall.`:'No investments tracked yet.'});
  brief.push({title:'Cash flow',text:c.income||c.spending?`${serverMoney(c.income)} recorded credits versus ${serverMoney(c.spending)} debits.`:'Import a bank statement to unlock cash-flow analysis.'});
  if(c.goals.length){const g=c.goals.slice().sort((a,b)=>a.remaining-b.remaining)[0];brief.push({title:'Next goal',text:`${g.name}: ${serverMoney(g.remaining)} remaining (${Number(g.progress).toFixed(1)}% complete).`});}
  if(top){const share=c.current?(c.topHoldingValue/c.current)*100:0;brief.push({title:'Concentration watch',text:`${top.asset_name} is your largest holding at about ${share.toFixed(1)}% of tracked portfolio value.`});}
  const provider=await aiProvider();
  res.json({welcome:provider.provider==='OpenAI'?'OpenAI-powered VaultQ AI is connected.':provider.provider==='Ollama'?`Local ${provider.model} AI is connected. No cloud API key is required.`:'VaultQ AI is running on its built-in reasoning engine. No API key is required.',provider,brief,quickQuestions:['How is my portfolio performing?','How diversified is my portfolio?','Where am I spending the most?','Can I improve my savings rate?','Which goal should I prioritize?','What should I review first?']});
});
app.post('/api/ai/ask',requireAuth,async(req,res)=>{
  const question=String(req.body?.question||'').trim(); if(!question)return res.status(400).json({message:'Ask a question first.'});
  const c=getAiContext(req.session.userId); const history=req.body?.history||[]; const provider=await aiProvider();
  try{
    if(provider.provider==='OpenAI'){const answer=await openAiAnswer(question,c,history);return res.json({answer,provider:'OpenAI',generatedAt:new Date().toISOString()});}
    if(provider.provider==='Ollama'){const answer=await ollamaAnswer(question,c,history);return res.json({answer,provider:'Ollama',model:provider.model,generatedAt:new Date().toISOString()});}
  }catch(e){console.error(`${provider.provider} AI request failed:`,e.message);}
  res.json({answer:localAiAnswer(question,c),provider:'VaultQ Local AI',generatedAt:new Date().toISOString()});
});
'''
p.write_text(s[:start]+new+s[end:])
