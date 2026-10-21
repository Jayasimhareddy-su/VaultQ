const bcrypt = require("bcryptjs");
const db = require("./db");

const DEMO_EMAIL = "demo@vaultq.com";
const DEMO_PASSWORD = "Demo@123";

let user = db.prepare("SELECT id, name FROM users WHERE email=?").get(DEMO_EMAIL);
if (!user) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const result = db.prepare("INSERT INTO users(name,email,password,cash_balance) VALUES(?,?,?,?)")
    .run("VaultQ Demo User", DEMO_EMAIL, hash, 125000);
  user = {id: Number(result.lastInsertRowid), name: "VaultQ Demo User"};
}

const uid = user.id;
// Re-runnable demo seed: clear only this demo user's generated data.
db.prepare("DELETE FROM bank_transactions WHERE user_id=?").run(uid);
db.prepare("DELETE FROM expenses WHERE user_id=?").run(uid);
db.prepare("DELETE FROM transactions WHERE user_id=?").run(uid);
db.prepare("DELETE FROM investments WHERE user_id=?").run(uid);
db.prepare("DELETE FROM goals WHERE user_id=?").run(uid);

db.prepare("UPDATE users SET cash_balance=125000 WHERE id=?").run(uid);

const investments = [
 ["Tata Motors","TATAMOTORS","Stocks",50,820,865],
 ["Reliance Industries","RELIANCE","Stocks",20,1180,1210],
 ["Infosys","INFY","Stocks",25,1450,1510],
 ["HDFC Bank","HDFCBANK","Stocks",30,1550,1680],
 ["SBI Mutual Fund","SBIMF","Mutual Funds",100,420,450],
 ["HDFC Mutual Fund","HDFCMF","Mutual Funds",80,510,535],
 ["Gold ETF","GOLDETF","Gold",10,6800,7850]
];
const insertInv=db.prepare(`INSERT INTO investments(user_id,asset_name,symbol,asset_type,quantity,buy_price,current_price) VALUES(?,?,?,?,?,?,?)`);
const insertTx=db.prepare(`INSERT INTO transactions(user_id,asset_name,symbol,transaction_type,quantity,price,total_amount,transaction_date) VALUES(?,?,?,?,?,?,?,?)`);
for(const [name,symbol,type,q,buy,current] of investments){
  insertInv.run(uid,name,symbol,type,q,buy,current);
  insertTx.run(uid,name,symbol,"BUY",q,buy,q*buy,"2026-10-"+(String(2+investments.indexOf(investments.find(x=>x[0]===name))).padStart(2,"0")));
}

const expenses=[
 ["Food & Dining","Zomato order",620,"2026-10-17"],
 ["Transport","Uber rides",840,"2026-10-16"],
 ["Bills & Utilities","Airtel broadband",999,"2026-10-15"],
 ["Shopping","Amazon purchase",2450,"2026-10-13"],
 ["Entertainment","Netflix subscription",649,"2026-10-10"],
 ["Healthcare","Pharmacy",780,"2026-10-08"],
 ["Education","Online course",1499,"2026-10-05"],
 ["Rent","Monthly rent",12000,"2026-10-01"]
];
const insertExp=db.prepare("INSERT INTO expenses(user_id,category,description,amount,expense_date) VALUES(?,?,?,?,?)");
for(const x of expenses) insertExp.run(uid,...x);

const goals=[
 ["Emergency Fund",300000,125000,"2027-06-30"],
 ["New Laptop",120000,65000,"2027-02-28"],
 ["Travel Fund",80000,32000,"2027-04-30"]
];
const insertGoal=db.prepare("INSERT INTO goals(user_id,name,target_amount,current_amount,target_date) VALUES(?,?,?,?,?)");
for(const g of goals) insertGoal.run(uid,...g);

const bankRows=[
 ["2026-10-18","Salary credit - ACME Technologies","SAL-1001",85000,"CREDIT"],
 ["2026-10-17","UPI-ZOMATO FOOD ORDER","UPI-8841",620,"DEBIT"],
 ["2026-10-16","UPI-UBER INDIA","UPI-7732",840,"DEBIT"],
 ["2026-10-15","AIRTEL BROADBAND BILL","BB-5512",999,"DEBIT"],
 ["2026-10-14","UPI-AMAZON INDIA","UPI-3321",2450,"DEBIT"],
 ["2026-10-13","UPI-SWIGGY","UPI-2291",540,"DEBIT"],
 ["2026-10-12","ATM CASH WITHDRAWAL","ATM-9912",5000,"DEBIT"],
 ["2026-10-11","NETFLIX SUBSCRIPTION","SUB-1122",649,"DEBIT"],
 ["2026-10-10","NEFT TRANSFER TO SAVINGS","NEFT-4312",10000,"DEBIT"],
 ["2026-10-09","APOLLO PHARMACY","UPI-6211",780,"DEBIT"],
 ["2026-10-08","COURSE - COURSERA","CARD-8821",1499,"DEBIT"],
 ["2026-10-07","DIVIDEND - RELIANCE","DIV-9012",1250,"CREDIT"],
 ["2026-10-05","MUTUAL FUND SIP - HDFC","SIP-7711",5000,"DEBIT"],
 ["2026-10-03","RENT PAYMENT","NEFT-3122",12000,"DEBIT"],
 ["2026-10-01","SALARY CREDIT - ACME Technologies","SAL-1000",85000,"CREDIT"]
];
function classify(d,dir){
 const s=d.toLowerCase();
 const rules=[
  ["Salary",/salary|payroll|wages/],["Food & Dining",/zomato|swiggy|food|restaurant/],
  ["Shopping",/amazon|flipkart|myntra|shopping/],["Bills & Utilities",/airtel|bill|broadband|recharge/],
  ["Transport",/uber|ola|metro|fuel|petrol/],["Investment",/mutual fund|sip|stock|etf|zerodha|groww/],
  ["Healthcare",/apollo|pharmacy|hospital|medical/],["Entertainment",/netflix|spotify|movie/],
  ["Education",/course|coursera|udemy|college/],["Transfer",/transfer|neft|rtgs|imps/],["Rent",/rent/],["ATM / Cash",/atm|cash withdrawal/]
 ];
 for(const [c,r] of rules) if(r.test(s)) return c;
 return dir==='CREDIT'?"Income":"Other";
}
const insertBank=db.prepare("INSERT INTO bank_transactions(user_id,transaction_date,description,reference,amount,direction,category,merchant) VALUES(?,?,?,?,?,?,?,?)");
for(const [date,desc,ref,amount,dir] of bankRows) insertBank.run(uid,date,desc,ref,amount,dir,classify(desc,dir),desc.split(/[-]/)[1]?.trim()||desc.slice(0,60));

console.log("\nVaultQ demo data seeded successfully!\n");
console.log("Demo login:");
console.log(`Email:    ${DEMO_EMAIL}`);
console.log(`Password: ${DEMO_PASSWORD}`);
console.log(`User ID:  ${uid}`);
console.log("\nIncluded: investments, portfolio transactions, expenses, goals, and categorized bank transactions.");
