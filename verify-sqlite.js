import Database from "better-sqlite3";
const db = new Database(":memory:");
console.log("better-sqlite3 is successfully installed and working!");
db.close();
