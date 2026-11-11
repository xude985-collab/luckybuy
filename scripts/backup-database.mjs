import fs from 'node:fs/promises';
import path from 'node:path';
import pg from '../server/node_modules/pg/lib/index.js';
const root = path.resolve(import.meta.dirname, '..');
const privateDir = path.join(root, '本地恢复资料');
const configPath = process.argv[2] || path.join(privateDir, 'new-database-private.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const connectionString = process.env.DATABASE_URL || config['External Database URL'];
const client = new pg.Client({ connectionString, ssl: connectionString.includes('render.com') ? {rejectUnauthorized:false} : false });
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const {rows: tables} = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const backup = {createdAt:new Date().toISOString(),format:'luckybuy-table-snapshot-v1',tables:{}};
  for(const {tablename} of tables) {
    if(!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table name');
    backup.tables[tablename]=(await client.query(`SELECT * FROM "${tablename}"`)).rows;
  }
  await client.query('COMMIT');
  const dir=path.join(privateDir,'数据库备份');await fs.mkdir(dir,{recursive:true});
  const output=path.join(dir,`snapshot-${Date.now()}.json`);
  await fs.writeFile(output,JSON.stringify(backup),{mode:0o600});
  console.log(JSON.stringify({file:output,tables:tables.length,rows:Object.values(backup.tables).reduce((n,r)=>n+r.length,0)}));
} finally {await client.end();}
