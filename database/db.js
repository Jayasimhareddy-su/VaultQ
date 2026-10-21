const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "vaultq.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cash_balance REAL NOT NULL DEFAULT 84350
);

CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_name TEXT NOT NULL,
    symbol TEXT,
    asset_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    buy_price REAL NOT NULL,
    current_price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_name TEXT NOT NULL,
    symbol TEXT,
    transaction_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    total_amount REAL NOT NULL,
    transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    amount REAL NOT NULL,
    expense_date TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);



CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    transaction_date TEXT NOT NULL,
    description TEXT NOT NULL,
    reference TEXT,
    amount REAL NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('CREDIT','DEBIT')),
    category TEXT NOT NULL DEFAULT 'Other',
    merchant TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_user_date
ON bank_transactions(user_id, transaction_date DESC);

CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL,
    current_amount REAL NOT NULL DEFAULT 0,
    target_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// Safe migration for databases created by earlier VaultQ versions.
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(x => x.name);
if (!userColumns.includes("cash_balance")) {
    db.exec("ALTER TABLE users ADD COLUMN cash_balance REAL NOT NULL DEFAULT 84350");
}

module.exports = db;

// Safe migration for bank transaction intelligence columns.
const bankColumns = db.prepare("PRAGMA table_info(bank_transactions)").all().map(x => x.name);
if (!bankColumns.includes("category")) db.exec("ALTER TABLE bank_transactions ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'");
if (!bankColumns.includes("merchant")) db.exec("ALTER TABLE bank_transactions ADD COLUMN merchant TEXT");
