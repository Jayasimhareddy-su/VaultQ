const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const db = require("../database/db");

// Tiny built-in .env loader so VaultQ works without an extra runtime package.
try {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
} catch (e) { console.warn("Could not read .env:", e.message); }

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const frontend = path.join(__dirname, "..", "frontend");

async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, headers: {
            "Accept": "application/json",
            ...(options.headers || {})
        }});
        if (!response.ok) throw new Error(`Upstream API returned ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}


app.use(express.json({ limit: "16mb" }));
app.set("trust proxy", 1);
app.use(session({
    secret: process.env.SESSION_SECRET || "vaultq-development-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000*60*60*24, httpOnly: true, sameSite: "lax", secure: isProduction }
}));
app.use(express.static(frontend));

const requireAuth = (req,res,next) => {
    if (!req.session.userId) return res.status(401).json({message:"Not logged in."});
    next();
};

const userById = id => db.prepare("SELECT id,name,email,created_at,cash_balance FROM users WHERE id=?").get(id);

app.get("/", (req,res)=>res.sendFile(path.join(frontend,"index.html")));

app.post("/api/register", async (req,res)=>{
    try {
        const {name,email,password} = req.body;
        if(!name || !email || !password) return res.status(400).json({message:"All fields are required."});
        if(password.length<6) return res.status(400).json({message:"Password must contain at least 6 characters."});
        const normalized = email.trim().toLowerCase();
        if(db.prepare("SELECT id FROM users WHERE email=?").get(normalized))
            return res.status(409).json({message:"An account with this email already exists."});
        const hash = await bcrypt.hash(password,10);
        const result = db.prepare("INSERT INTO users(name,email,password) VALUES(?,?,?)").run(name.trim(),normalized,hash);
        req.session.userId = result.lastInsertRowid;
        res.status(201).json({message:"Account created successfully.",user:userById(req.session.userId)});
    } catch(e){ console.error(e); res.status(500).json({message:"Registration failed."}); }
});

app.post("/api/login", async (req,res)=>{
    try {
        const {email,password}=req.body;
        const user=db.prepare("SELECT * FROM users WHERE email=?").get((email||"").trim().toLowerCase());
        if(!user || !(await bcrypt.compare(password||"",user.password)))
            return res.status(401).json({message:"Invalid email or password."});
        req.session.userId=user.id;
        res.json({message:"Login successful.",user:userById(user.id)});
    } catch(e){res.status(500).json({message:"Login failed."});}
});

app.get("/api/me",requireAuth,(req,res)=>res.json({user:userById(req.session.userId)}));

app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({message:"Logged out."})));

app.get("/api/dashboard",requireAuth,(req,res)=>{
    const uid=req.session.userId;
    const inv=db.prepare("SELECT * FROM investments WHERE user_id=? ORDER BY current_price*quantity DESC").all(uid);
    const invested=inv.reduce((s,x)=>s+x.quantity*x.buy_price,0);
    const current=inv.reduce((s,x)=>s+x.quantity*x.current_price,0);
    const profit=current-invested;
    const allocation={};
    inv.forEach(x=>allocation[x.asset_type]=(allocation[x.asset_type]||0)+x.quantity*x.current_price);
    const transactions=db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY transaction_date DESC,id DESC LIMIT 8").all(uid);
    const allTransactions=db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY transaction_date ASC,id ASC").all(uid);
    const expenses=db.prepare("SELECT * FROM expenses WHERE user_id=? ORDER BY expense_date DESC,id DESC LIMIT 6").all(uid);
    const goals=db.prepare("SELECT * FROM goals WHERE user_id=? ORDER BY target_date LIMIT 4").all(uid);
    const totalExpenses=db.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE user_id=?").get(uid).total;
    const monthExpenses=db.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE user_id=? AND substr(expense_date,1,7)=strftime('%Y-%m','now')").get(uid).total;
    const topAsset=inv[0] ? {name:inv[0].asset_name,value:inv[0].quantity*inv[0].current_price} : null;
    const goalProgress=goals.length ? goals.reduce((sum,g)=>sum+Math.min(100,(g.current_amount/g.target_amount)*100),0)/goals.length : 0;
    const cash=db.prepare("SELECT cash_balance FROM users WHERE id=?").get(uid).cash_balance;

    // Bank-import intelligence feeds the dashboard without storing statement files.
    const bankSummary=db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0) income,
        COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0) spending
      FROM bank_transactions WHERE user_id=?
    `).get(uid);
    const monthlyBank=db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0) income,
        COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0) spending
      FROM bank_transactions
      WHERE user_id=? AND substr(transaction_date,1,7)=strftime('%Y-%m','now')
    `).get(uid);
    const categorySpend=db.prepare(`
      SELECT category, COALESCE(SUM(amount),0) amount
      FROM bank_transactions
      WHERE user_id=? AND direction='DEBIT'
      GROUP BY category ORDER BY amount DESC LIMIT 5
    `).all(uid);
    const largestExpense=categorySpend[0] || null;
    const monthlyIncome=Number(monthlyBank.income||0);
    const monthlySpending=Math.max(Number(monthlyBank.spending||0),Number(monthExpenses||0));
    const savingsRate=monthlyIncome>0 ? Math.max(0,(monthlyIncome-monthlySpending)/monthlyIncome*100) : null;
    const goalDetails=goals.map(g=>({name:g.name,target:g.target_amount,current:g.current_amount,remaining:Math.max(0,g.target_amount-g.current_amount)}));
    const nextGoal=goalDetails.sort((a,b)=>a.remaining-b.remaining)[0] || null;

    // This is an investment-flow chart, not fabricated historical market pricing.
    let running=0;
    const flow=allTransactions.slice(-8).map(t=>{
        running += t.transaction_type === 'BUY' ? t.total_amount : -t.total_amount;
        return {date:t.transaction_date, value:Math.max(0,running)};
    });
    if (!flow.length) flow.push({date:new Date().toISOString(),value:invested});
    flow.push({date:new Date().toISOString(),value:current});

    res.json({
      portfolio:{invested,current,profit,returnPct:invested?profit/invested*100:0},
      allocation:Object.entries(allocation).map(([asset_type,value])=>({asset_type,value})),
      investments:inv, transactions,expenses,goals,cash,
      insights:{
        totalExpenses,monthExpenses,goalProgress,topAsset,holdingCount:inv.length,
        bankIncome:bankSummary.income,bankSpending:bankSummary.spending,
        monthlyIncome,monthlySpending,savingsRate,categorySpend,largestExpense,nextGoal,
        diversification:inv.length>=5?'Well diversified':inv.length>=3?'Moderately diversified':'Needs diversification'
      },
      flow
    });
});

app.patch("/api/cash",requireAuth,(req,res)=>{
    const amount=Number(req.body.amount);
    if(!Number.isFinite(amount) || amount<0) return res.status(400).json({message:"Enter a valid cash amount."});
    db.prepare("UPDATE users SET cash_balance=? WHERE id=?").run(amount,req.session.userId);
    res.json({cash:amount});
});

app.get("/api/investments",requireAuth,(req,res)=>{
    res.json({investments:db.prepare("SELECT * FROM investments WHERE user_id=? ORDER BY id DESC").all(req.session.userId)});
});

app.post("/api/investments",requireAuth,(req,res)=>{
    const {asset_name,symbol,asset_type,quantity,buy_price,current_price}=req.body;
    if(!asset_name||!asset_type||!(quantity>0)||!(buy_price>0)||!(current_price>0))
        return res.status(400).json({message:"Enter valid investment details."});
    const r=db.prepare(`
      INSERT INTO investments(user_id,asset_name,symbol,asset_type,quantity,buy_price,current_price)
      VALUES(?,?,?,?,?,?,?)
    `).run(req.session.userId,asset_name.trim(),symbol||"",asset_type,quantity,buy_price,current_price);
    db.prepare(`
      INSERT INTO transactions(user_id,asset_name,symbol,transaction_type,quantity,price,total_amount)
      VALUES(?,?,?,?,?,?,?)
    `).run(req.session.userId,asset_name.trim(),symbol||"","BUY",quantity,buy_price,quantity*buy_price);
    res.status(201).json({investment:db.prepare("SELECT * FROM investments WHERE id=?").get(r.lastInsertRowid)});
});

app.delete("/api/investments/:id",requireAuth,(req,res)=>{
    const inv=db.prepare("SELECT * FROM investments WHERE id=? AND user_id=?").get(req.params.id,req.session.userId);
    if(!inv) return res.status(404).json({message:"Investment not found."});
    db.prepare("DELETE FROM investments WHERE id=? AND user_id=?").run(req.params.id,req.session.userId);
    db.prepare(`
      INSERT INTO transactions(user_id,asset_name,symbol,transaction_type,quantity,price,total_amount)
      VALUES(?,?,?,?,?,?,?)
    `).run(req.session.userId,inv.asset_name,inv.symbol,"SELL",inv.quantity,inv.current_price,inv.quantity*inv.current_price);
    res.json({message:"Investment sold and removed."});
});

app.get("/api/transactions",requireAuth,(req,res)=>{
    res.json({transactions:db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY transaction_date DESC,id DESC").all(req.session.userId)});
});

app.get("/api/expenses",requireAuth,(req,res)=>{
    res.json({expenses:db.prepare("SELECT * FROM expenses WHERE user_id=? ORDER BY expense_date DESC,id DESC").all(req.session.userId)});
});
app.post("/api/expenses",requireAuth,(req,res)=>{
    const {category,description,amount,expense_date}=req.body;
    if(!category || !(amount>0) || !expense_date) return res.status(400).json({message:"Enter valid expense details."});
    const r=db.prepare("INSERT INTO expenses(user_id,category,description,amount,expense_date) VALUES(?,?,?,?,?)")
      .run(req.session.userId,category,description||"",amount,expense_date);
    res.status(201).json({expense:db.prepare("SELECT * FROM expenses WHERE id=?").get(r.lastInsertRowid)});
});
app.delete("/api/expenses/:id",requireAuth,(req,res)=>{
    db.prepare("DELETE FROM expenses WHERE id=? AND user_id=?").run(req.params.id,req.session.userId);
    res.json({message:"Expense deleted."});
});

app.get("/api/goals",requireAuth,(req,res)=>{
    res.json({goals:db.prepare("SELECT * FROM goals WHERE user_id=? ORDER BY target_date").all(req.session.userId)});
});
app.post("/api/goals",requireAuth,(req,res)=>{
    const {name,target_amount,current_amount,target_date}=req.body;
    if(!name || !(target_amount>0)) return res.status(400).json({message:"Enter a valid goal."});
    const r=db.prepare("INSERT INTO goals(user_id,name,target_amount,current_amount,target_date) VALUES(?,?,?,?,?)")
      .run(req.session.userId,name,target_amount,Math.max(0,Number(current_amount)||0),target_date||null);
    res.status(201).json({goal:db.prepare("SELECT * FROM goals WHERE id=?").get(r.lastInsertRowid)});
});
app.patch("/api/goals/:id",requireAuth,(req,res)=>{
    const {current_amount}=req.body;
    db.prepare("UPDATE goals SET current_amount=? WHERE id=? AND user_id=?")
      .run(Math.max(0,Number(current_amount)||0),req.params.id,req.session.userId);
    res.json({message:"Goal updated."});
});
app.delete("/api/goals/:id",requireAuth,(req,res)=>{
    db.prepare("DELETE FROM goals WHERE id=? AND user_id=?").run(req.params.id,req.session.userId);
    res.json({message:"Goal deleted."});
});

const BANK_CACHE_FILE = path.join(__dirname, "../database/ratescan-bank-cache.json");
const BANK_REFRESH_MS = 30 * 60 * 1000;
let bankCache = { at: 0, data: null };
let bankRefreshPromise = null;

const fallbackBanks = [
  ['sbi','State Bank of India','PUBLIC'],['hdfc-bank','HDFC Bank','PRIVATE'],['icici-bank','ICICI Bank','PRIVATE'],
  ['axis-bank','Axis Bank','PRIVATE'],['kotak-mahindra-bank','Kotak Mahindra Bank','PRIVATE'],['punjab-national-bank','Punjab National Bank','PUBLIC'],
  ['bank-of-baroda','Bank of Baroda','PUBLIC'],['canara-bank','Canara Bank','PUBLIC'],['union-bank-of-india','Union Bank of India','PUBLIC'],
  ['indian-bank','Indian Bank','PUBLIC'],['bank-of-india','Bank of India','PUBLIC'],['central-bank-of-india','Central Bank of India','PUBLIC'],
  ['uco-bank','UCO Bank','PUBLIC'],['bank-of-maharashtra','Bank of Maharashtra','PUBLIC'],['indian-overseas-bank','Indian Overseas Bank','PUBLIC'],
  ['punjab-and-sind-bank','Punjab & Sind Bank','PUBLIC'],['idbi-bank','IDBI Bank','PUBLIC'],['idfc-first-bank','IDFC FIRST Bank','PRIVATE'],
  ['indusind-bank','IndusInd Bank','PRIVATE'],['yes-bank','YES BANK','PRIVATE'],['federal-bank','Federal Bank','PRIVATE'],
  ['rbl-bank','RBL Bank','PRIVATE'],['bandhan-bank','Bandhan Bank','PRIVATE'],['south-indian-bank','South Indian Bank','PRIVATE'],
  ['karur-vysya-bank','Karur Vysya Bank','PRIVATE'],['city-union-bank','City Union Bank','PRIVATE'],['dcb-bank','DCB Bank','PRIVATE'],
  ['au-small-finance-bank','AU Small Finance Bank','SMALL_FINANCE'],['equitas-small-finance-bank','Equitas Small Finance Bank','SMALL_FINANCE'],
  ['unity-small-finance-bank','Unity Small Finance Bank','SMALL_FINANCE'],['suryoday-small-finance-bank','Suryoday Small Finance Bank','SMALL_FINANCE'],
  ['ujjivan-small-finance-bank','Ujjivan Small Finance Bank','SMALL_FINANCE'],['esaf-small-finance-bank','ESAF Small Finance Bank','SMALL_FINANCE'],
  ['jana-small-finance-bank','Jana Small Finance Bank','SMALL_FINANCE'],['fincare-small-finance-bank','Fincare Small Finance Bank','SMALL_FINANCE'],
  ['andhra-pradesh-grameena-bank','Andhra Pradesh Grameena Bank','REGIONAL_RURAL'],['telangana-gramena-bank','Telangana Grameena Bank','REGIONAL_RURAL'],
  ['karnataka-grameena-bank','Karnataka Grameena Bank','REGIONAL_RURAL'],['kerala-gramin-bank','Kerala Gramin Bank','REGIONAL_RURAL'],
  ['baroda-gujarat-gramin-bank','Baroda Gujarat Gramin Bank','REGIONAL_RURAL'],['uttar-pradesh-gramin-bank','Uttar Pradesh Gramin Bank','REGIONAL_RURAL']
].map(([id,name,category])=>({id,name,type:category,category,states:['ALL'],website:'',savingsRate:null,fdRate:null,peakFdRate:null,peakFdTenure:null,seniorPeakRate:null,seniorPeakTenure:null,checkedAt:null}));

function readBankDiskCache(){
  try{
    if(!fs.existsSync(BANK_CACHE_FILE)) return null;
    const raw=JSON.parse(fs.readFileSync(BANK_CACHE_FILE,'utf8'));
    if(raw && Array.isArray(raw.banks) && raw.banks.length) return raw;
  }catch(e){ console.warn('Bank cache read failed:',e.message); }
  return null;
}
function writeBankDiskCache(data){
  try{
    fs.mkdirSync(path.dirname(BANK_CACHE_FILE),{recursive:true});
    const tmp=`${BANK_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify(data));
    fs.renameSync(tmp,BANK_CACHE_FILE);
  }catch(e){ console.warn('Bank cache write failed:',e.message); }
}
function normalizeBanks(raw){
  return (Array.isArray(raw)?raw:[]).map(b=>({
    id:String(b.id), name:b.name||b.bankName||String(b.id),
    type:b.category||b.type||'BANK', category:b.category||b.type||'BANK',
    states:Array.isArray(b.states)?b.states:['ALL'], website:b.website||'',
    savingsRate:b.savingsRate??null, fdRate:b.fdRate??null,
    peakFdRate:b.peakFdRate??null, peakFdTenure:b.peakFdTenure??null,
    seniorPeakRate:b.seniorPeakRate??null, seniorPeakTenure:b.seniorPeakTenure??null,
    checkedAt:b.checkedAt??null
  }));
}
function summarizeRates(rows){
  const byBank={};
  for(const r of (Array.isArray(rows)?rows:[])){
    if(!r || !r.bankId) continue;
    const minAmount=Number(r?.amount?.minAmount||0);
    if(minAmount!==0) continue;
    const id=String(r.bankId);
    (byBank[id] ||= []).push(r);
  }
  const out={};
  for(const [id,rowsForBank] of Object.entries(byBank)){
    const generalFd=rowsForBank.filter(r=>r.product==='FD'&&r.customer==='GENERAL');
    const seniorFd=rowsForBank.filter(r=>r.product==='FD'&&r.customer==='SENIOR');
    const savings=rowsForBank.filter(r=>r.product==='SAVINGS');
    const oneYear=generalFd.filter(r=>r.tenure && Number(r.tenure.minDays||0)<=365 && (r.tenure.maxDays==null || Number(r.tenure.maxDays)>=365));
    const peak=generalFd.slice().sort((a,b)=>Number(b.ratePercent)-Number(a.ratePercent))[0]||null;
    const senior=seniorFd.slice().sort((a,b)=>Number(b.ratePercent)-Number(a.ratePercent))[0]||null;
    const sav=savings.slice().sort((a,b)=>Number(b.ratePercent)-Number(a.ratePercent))[0]||null;
    const fd=oneYear.slice().sort((a,b)=>Number(b.ratePercent)-Number(a.ratePercent))[0]||null;
    const checked=[peak,senior,sav,fd].map(r=>Date.parse(r?.source?.checkedAt||'')||0).reduce((a,v)=>Math.max(a,v),0);
    out[id]={
      savingsRate:sav?.ratePercent??null, fdRate:fd?.ratePercent??null,
      peakFdRate:peak?.ratePercent??null, peakFdTenure:peak?.tenure?.label||null,
      seniorPeakRate:senior?.ratePercent??null, seniorPeakTenure:senior?.tenure?.label||null,
      checkedAt:checked||null
    };
  }
  return out;
}

function getCurrentBankData(){
  if(!bankCache.data){
    const disk=readBankDiskCache();
    bankCache={at:disk?.at||0,data:disk||{banks:fallbackBanks,generatedAt:null,count:fallbackBanks.length,source:'VaultQ built-in fallback'}};
  }
  return bankCache.data;
}

async function refreshBankCache(force=false){
  const now=Date.now();
  if(!force && bankCache.data && now-bankCache.at < BANK_REFRESH_MS) return bankCache.data;
  if(bankRefreshPromise) return bankRefreshPromise;
  bankRefreshPromise=(async()=>{
    try{
      // RateScan publishes a static dataset. Fetch it in the background so the UI never waits for it.
      const dataset=await fetchJson('https://ratescan.in/data/dataset.json');
      const rawBanks=Array.isArray(dataset?.banks)?dataset.banks:[];
      const rawRates=Array.isArray(dataset?.rates)?dataset.rates:[];
      if(!rawBanks.length) throw new Error('RateScan dataset contained no banks.');
      const previous=getCurrentBankData();
      const rateSummary=summarizeRates(rawRates);
      const banks=normalizeBanks(rawBanks).map(b=>({...b,...(rateSummary[b.id]||{})}));
      const data={banks,generatedAt:dataset.generatedAt||new Date().toISOString(),count:banks.length,source:'RateScan.in',build:dataset.build||null,at:now};
      bankCache={at:now,data};
      writeBankDiskCache(data);
      console.log(`Bank cache refreshed: ${banks.length} banks, ${rawRates.length} rates.`);
      return data;
    }catch(e){
      console.warn('Background RateScan refresh failed:',e.message);
      return getCurrentBankData();
    }finally{ bankRefreshPromise=null; }
  })();
  return bankRefreshPromise;
}

// Load whatever was previously saved before the first request.
const diskBankCache=readBankDiskCache();
if(diskBankCache?.banks?.length) bankCache={at:diskBankCache.at||0,data:diskBankCache};

app.get('/api/banks', (req,res)=>{
  const data=getCurrentBankData();
  // Refresh asynchronously. The response is always served from local memory/disk.
  refreshBankCache(false).catch(()=>{});
  res.json({banks:data.banks,minimumSelection:2,generatedAt:data.generatedAt,count:data.count,source:data.source,refreshing:Boolean(bankRefreshPromise),cached:true});
});

app.post('/api/banks/refresh', (req,res)=>{
  refreshBankCache(true).then(data=>res.json({message:'Bank cache refreshed.',banks:data.banks,generatedAt:data.generatedAt,count:data.count,source:data.source})).catch(e=>res.status(502).json({message:e.message}));
});

function parseAmount(value){
    if(value===undefined || value===null) return null;
    const cleaned=String(value).replace(/[₹,$\s]/g,"").replace(/,/g,"");
    const n=Number(cleaned);
    return Number.isFinite(n) ? Math.abs(n) : null;
}

function normalizeDate(value){
    const raw=String(value||"").trim();
    let m=raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if(!m) m=raw.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{2,4})$/);
    if(m){
        let [,d,mo,y]=m;
        if(/[A-Za-z]/.test(mo)){ const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}; mo=months[mo.slice(0,3).toLowerCase()]; }
        y=Number(y); if(y<100)y+=2000;
        if(mo) return `${y}-${String(Number(mo)).padStart(2,"0")}-${String(Number(d)).padStart(2,"0")}`;
    }
    const dt=new Date(raw);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0,10);
}

function parseCsvStatement(text){
    const lines=text.replace(/\r/g,"").split("\n").filter(Boolean);
    if(!lines.length) return [];
    const split=(line)=>{
        const out=[]; let cur=""; let quoted=false;
        for(let i=0;i<line.length;i++){ const c=line[i]; if(c==='"'){ if(quoted && line[i+1]==='"'){cur+='"';i++;} else quoted=!quoted; } else if(c===',' && !quoted){out.push(cur.trim());cur="";} else cur+=c; }
        out.push(cur.trim()); return out;
    };
    const headers=split(lines[0]).map(x=>x.toLowerCase());
    const find=(names)=>headers.findIndex(h=>names.some(n=>h.includes(n)));
    const dateIdx=find(["date","transaction date","txn date"]);
    const descIdx=find(["description","narration","details","particular"]);
    const debitIdx=find(["debit","withdrawal","dr"]);
    const creditIdx=find(["credit","deposit","cr"]);
    const amountIdx=find(["amount","transaction amount"]);
    const refIdx=find(["reference","ref no","transaction id","utr"]);
    if(dateIdx<0 || descIdx<0 || (debitIdx<0 && creditIdx<0 && amountIdx<0)) throw new Error("Could not identify transaction columns. Use a CSV with Date, Description, Debit/Credit or Amount columns.");
    const rows=[];
    for(const line of lines.slice(1)){
        const cols=split(line); const date=normalizeDate(cols[dateIdx]); const description=(cols[descIdx]||"").trim();
        if(!date || !description) continue;
        let amount=null,direction=null;
        const debit=debitIdx>=0?parseAmount(cols[debitIdx]):null; const credit=creditIdx>=0?parseAmount(cols[creditIdx]):null;
        if(credit!==null && credit>0){amount=credit;direction="CREDIT";} else if(debit!==null && debit>0){amount=debit;direction="DEBIT";}
        else if(amountIdx>=0){ const raw=String(cols[amountIdx]||""); amount=parseAmount(raw); direction=/[-(]\s*₹?/i.test(raw)||/debit|withdrawal|dr/i.test(raw)?"DEBIT":"CREDIT"; }
        if(amount!==null && amount>0) rows.push({transaction_date:date,description:description.slice(0,500),reference:refIdx>=0?String(cols[refIdx]||"").slice(0,150):"",amount,direction});
    }
    return rows;
}

function parsePdfStatement(text){
    const rows=[];
    const lines=text.replace(/\r/g,"").split("\n").map(x=>x.trim()).filter(Boolean);
    const dateRe=/^(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ]\d{2,4})\b/i;
    for(let i=0;i<lines.length;i++){
        const line=lines[i]; const dm=line.match(dateRe); if(!dm) continue;
        const date=normalizeDate(dm[1]); if(!date) continue;
        const tail=line.slice(dm[0].length).trim();
        const amounts=[...tail.matchAll(/(?:₹\s*)?(-?\(?\d[\d,]*(?:\.\d{1,2})?\)?)/g)].map(m=>({raw:m[1],index:m.index}));
        if(!amounts.length) continue;
        const last=amounts[amounts.length-1];
        const amount=parseAmount(last.raw); if(!amount) continue;
        const before=tail.slice(0,last.index).trim();
        const description=before.replace(/\s+/g," ").trim();
        if(!description || /^(date|opening balance|closing balance|balance)$/i.test(description)) continue;
        const direction=/\b(cr|credit|deposit|salary|refund)\b/i.test(tail) ? "CREDIT" : /\b(dr|debit|withdrawal|payment|purchase)\b/i.test(tail) ? "DEBIT" : (last.raw.includes("-")||last.raw.includes("(")) ? "DEBIT" : "DEBIT";
        rows.push({transaction_date:date,description:description.slice(0,500),reference:"",amount,direction});
    }
    return rows;
}

function extractPdfText(filePath,password){
    return new Promise((resolve,reject)=>{
        execFile("pdftotext",["-layout","-enc","UTF-8","-upw",password||"",filePath,"-"],{maxBuffer:20*1024*1024},(error,stdout,stderr)=>{
            if(error){
                const message=/password|encrypted|incorrect/i.test(stderr||"") ? "The statement password is incorrect or the PDF is encrypted in an unsupported way." : "VaultQ could not read this PDF. It may be scanned/image-only or damaged.";
                return reject(new Error(message));
            }
            resolve(stdout);
        });
    });
}

function classifyBankTransaction(description, direction, amount){
    const d=String(description||"").toLowerCase();
    const rules=[
      ["Salary",/salary|payroll|wages|credit salary/],
      ["Food & Dining",/swiggy|zomato|restaurant|cafe|food|dominos|mcdonald|starbucks/],
      ["Shopping",/amazon|flipkart|myntra|ajio|shopping|mall|retail/],
      ["Bills & Utilities",/electricity|water bill|gas bill|recharge|airtel|jio|vi |bsnl|internet|broadband|utility/],
      ["Transport",/uber|ola|rapido|metro|fuel|petrol|diesel|parking|toll/],
      ["Investment",/zerodha|groww|upstox|mutual fund|sip|nse|bse|stock|etf|investment/],
      ["Healthcare",/hospital|pharmacy|medical|apollo|health/],
      ["Entertainment",/netflix|spotify|prime video|movie|cinema|bookmyshow|youtube/],
      ["Education",/college|university|course|udemy|coursera|education|school/],
      ["Transfer",/upi transfer|bank transfer|neft|rtgs|imps|self transfer|to savings|from savings/],
      ["Rent",/rent|lease/],
      ["ATM / Cash",/atm|cash withdrawal|cash deposit/]
    ];
    for(const [category,regex] of rules) if(regex.test(d)) return {category,merchant:extractMerchant(description)};
    return {category:direction==='CREDIT' ? 'Income' : 'Other',merchant:extractMerchant(description)};
}
function extractMerchant(description){
    const raw=String(description||"").replace(/\\s+/g," ").trim();
    const cleaned=raw.replace(/(?:upi|neft|rtgs|imps)[\s\-:/]*/ig,"").replace(/\b\d{8,}\b/g,"").trim();
    return cleaned.slice(0,100) || null;
}
function importBankRows(userId, rows){
    const insert=db.prepare("INSERT INTO bank_transactions(user_id,transaction_date,description,reference,amount,direction,category,merchant) VALUES(?,?,?,?,?,?,?,?)");
    const expenseInsert=db.prepare("INSERT INTO expenses(user_id,category,description,amount,expense_date) VALUES(?,?,?,?,?)");
    let imported=0, expensesCreated=0;
    const tx=db.transaction(items=>{
      for(const item of items){
        const classified=classifyBankTransaction(item.description,item.direction,item.amount);
        insert.run(userId,item.transaction_date,item.description,item.reference||"",item.amount,item.direction,classified.category,classified.merchant);
        imported++;
        if(item.direction==='DEBIT' && !['Transfer','Investment','ATM / Cash'].includes(classified.category)){
          expenseInsert.run(userId,classified.category,item.description,item.amount,item.transaction_date);
          expensesCreated++;
        }
      }
    });
    tx(rows);
    return {imported,expensesCreated};
}

app.get("/api/bank-transactions",requireAuth,(req,res)=>{
    const limit=Math.min(500,Math.max(1,Number(req.query.limit)||100));
    res.json({transactions:db.prepare("SELECT id,transaction_date,description,reference,amount,direction,category,merchant FROM bank_transactions WHERE user_id=? ORDER BY transaction_date DESC,id DESC LIMIT ?").all(req.session.userId,limit)});
});

app.post("/api/bank-statements/import",requireAuth,async(req,res)=>{
    const {fileName,fileBase64,password=""}=req.body||{};
    if(!fileName || !fileBase64) return res.status(400).json({message:"Choose a bank statement first."});
    const safeName=String(fileName).toLowerCase();
    if(!safeName.endsWith(".pdf") && !safeName.endsWith(".csv")) return res.status(400).json({message:"VaultQ currently accepts PDF or CSV statements."});
    let buffer;
    try{ buffer=Buffer.from(String(fileBase64).replace(/^data:[^;]+;base64,/,""),"base64"); }catch(e){return res.status(400).json({message:"The uploaded statement could not be decoded."});}
    if(!buffer.length || buffer.length>12*1024*1024) return res.status(400).json({message:"Statement must be between 1 byte and 12 MB."});
    const tempPath=path.join(os.tmpdir(),`vaultq-statement-${crypto.randomUUID()}${safeName.endsWith(".pdf")?".pdf":".csv"}`);
    try{
        let text;
        if(safeName.endsWith(".pdf")){ fs.writeFileSync(tempPath,buffer,{mode:0o600}); text=await extractPdfText(tempPath,String(password||"")); }
        else text=buffer.toString("utf8");
        const rows=safeName.endsWith(".csv")?parseCsvStatement(text):parsePdfStatement(text);
        if(!rows.length) return res.status(422).json({message:"No readable transactions were found. Try a text-based PDF or CSV with Date, Description and Debit/Credit or Amount columns."});
        const result=importBankRows(req.session.userId,rows.slice(0,500));
        res.json({message:`Imported ${result.imported} transactions and categorized them automatically. The uploaded statement was not stored.`,imported:result.imported,expensesCreated:result.expensesCreated,skipped:Math.max(0,rows.length-500)});
    }catch(e){ console.error("Bank statement import failed:",e.message); res.status(422).json({message:e.message||"Could not read the statement."}); }
    finally{ try{if(fs.existsSync(tempPath)) fs.unlinkSync(tempPath);}catch(e){} }
});

app.get("/api/bank-transactions/summary",requireAuth,(req,res)=>{
    const uid=req.session.userId;
    const rows=db.prepare("SELECT * FROM bank_transactions WHERE user_id=? ORDER BY transaction_date DESC,id DESC").all(uid);
    const summary={credits:0,debits:0,net:0,count:rows.length,categories:{},monthly:{}};
    for(const r of rows){
      if(r.direction==='CREDIT') summary.credits+=r.amount; else summary.debits+=r.amount;
      summary.net=summary.credits-summary.debits;
      summary.categories[r.category]=(summary.categories[r.category]||0)+ (r.direction==='DEBIT'?r.amount:0);
      const month=String(r.transaction_date).slice(0,7); if(!summary.monthly[month]) summary.monthly[month]={credit:0,debit:0};
      summary.monthly[month][r.direction==='CREDIT'?'credit':'debit']+=r.amount;
    }
    res.json(summary);
});

app.delete("/api/bank-transactions",requireAuth,(req,res)=>{
    db.prepare("DELETE FROM bank_transactions WHERE user_id=?").run(req.session.userId);
    res.json({message:"Imported bank transactions deleted."});
});

async function yahooQuote(symbol){
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    const data=await fetchJson(url);
    const meta=data?.chart?.result?.[0]?.meta||{};
    const price=Number(meta.regularMarketPrice ?? meta.previousClose);
    const prev=Number(meta.previousClose);
    return {symbol,price,previousClose:prev,change:prev?((price-prev)/prev)*100:0,currency:meta.currency||'INR',timestamp:meta.regularMarketTime?new Date(meta.regularMarketTime*1000).toISOString():null,marketState:meta.marketState||'UNKNOWN'};
}

app.get("/api/market", async (req,res)=>{
    const items=[];
    const sources={indices:'Yahoo Finance',metals:'Yahoo Finance',crypto:'CoinGecko'};
    let usdInr=95;
    try{
      const fx=await fetchJson('https://api.frankfurter.dev/v2/rate/usd/inr');
      usdInr=Number(fx.rate)||usdInr;
    }catch(e){}
    const tasks=[
      ['NIFTY 50','^NSEI','index'],['SENSEX','^BSESN','index'],['GOLD','GC=F','gold'],['SILVER','SI=F','silver']
    ];
    for(const [name,symbol,type] of tasks){
      try{
        const q=await yahooQuote(symbol);
        const value=type==='index'?q.price:(q.price*usdInr/31.1034768*(type==='gold'?10:1000));
        const unit=type==='gold'?'₹/10g':type==='silver'?'₹/kg':'points';
        items.push({name,symbol,value,change:q.change,currency:type==='index'?'INR': 'INR',unit,source:sources[type==='index'?'indices':'metals'],timestamp:q.timestamp,marketState:q.marketState,rawPrice:q.price,fx:usdInr});
      }catch(e){items.push({name,symbol,value:null,change:0,currency:'INR',unit:type==='index'?'points':'reference',source:sources[type==='index'?'indices':'metals'],error:true});}
    }
    let crypto=[];
    let cryptoLive=false;
    try{
      const cg=await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr&include_24hr_change=true&include_last_updated_at=true');
      if(cg.bitcoin){crypto=[{name:'Bitcoin',symbol:'BTC',value:Number(cg.bitcoin.inr),change:Number(cg.bitcoin.inr_24h_change||0),currency:'INR',unit:'BTC',source:'CoinGecko',timestamp:cg.bitcoin.last_updated_at?new Date(cg.bitcoin.last_updated_at*1000).toISOString():null}];cryptoLive=true;}
    }catch(e){}
    res.json({updatedAt:new Date().toISOString(),live:{indices:items.filter(x=>x.name==='NIFTY 50'||x.name==='SENSEX').every(x=>x.value!==null),metals:items.filter(x=>x.name==='GOLD'||x.name==='SILVER').every(x=>x.value!==null),crypto:cryptoLive},items,crypto,usdInr});
});

app.get("/api/fx", async (req,res)=>{
    try {
        const base=String(req.query.base||"USD").toUpperCase();
        const quotes=String(req.query.quotes||"INR,EUR,GBP,JPY").toUpperCase();
        const data=await fetchJson(`https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(quotes)}`);
        res.json({source:"Frankfurter",live:true,data});
    } catch(e) { res.status(502).json({message:"Currency API is temporarily unavailable."}); }
});

app.get("/api/crypto", async (req,res)=>{
    try {
        const ids=String(req.query.ids||"bitcoin,ethereum,solana");
        const data=await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=inr&include_24hr_change=true`);
        res.json({source:"CoinGecko",live:true,data});
    } catch(e) { res.status(502).json({message:"Crypto API is temporarily unavailable."}); }
});


function serverMoney(v){return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(v)||0)}
function serverPct(v){const n=Number(v)||0;return `${n>=0?"+":""}${n.toFixed(2)}%`}
// VaultQ AI: account-aware financial copilot.
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
app.get("/api/health", (req,res)=>res.json({status:"ok",service:"VaultQ API",time:new Date().toISOString()}));

app.put("/api/profile",requireAuth,(req,res)=>{
    const {name,email}=req.body;
    if(!name||!email) return res.status(400).json({message:"Name and email are required."});
    try {
      db.prepare("UPDATE users SET name=?,email=? WHERE id=?").run(name.trim(),email.trim().toLowerCase(),req.session.userId);
      res.json({user:userById(req.session.userId)});
    } catch(e){res.status(400).json({message:"Email may already be in use."});}
});

app.put("/api/password",requireAuth,async(req,res)=>{
    const {currentPassword,newPassword}=req.body;
    const user=db.prepare("SELECT password FROM users WHERE id=?").get(req.session.userId);
    if(!(await bcrypt.compare(currentPassword||"",user.password))) return res.status(400).json({message:"Current password is incorrect."});
    if(!newPassword || newPassword.length<6) return res.status(400).json({message:"New password must contain at least 6 characters."});
    const hash=await bcrypt.hash(newPassword,10);
    db.prepare("UPDATE users SET password=? WHERE id=?").run(hash,req.session.userId);
    res.json({message:"Password updated."});
});

app.listen(PORT,()=>{
  console.log(`VaultQ running at http://localhost:${PORT}`);
  setTimeout(()=>refreshBankCache(false).catch(()=>{}),1000);
  setInterval(()=>refreshBankCache(false).catch(()=>{}),BANK_REFRESH_MS);
});
