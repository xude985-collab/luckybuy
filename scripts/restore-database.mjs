// Restore ONLY to an empty destination explicitly supplied by the operator.
import fs from 'node:fs/promises';
if(!process.argv[2] || process.argv[3]!=='--empty-only' || !process.env.RESTORE_DATABASE_URL)throw new Error('Usage: RESTORE_DATABASE_URL=<new empty database> node scripts/restore-database.mjs <snapshot.json> --empty-only');
process.env.DOTENV_CONFIG_PATH='__restore_no_env__';
process.env.DATABASE_URL=process.env.RESTORE_DATABASE_URL;
const backup=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(backup.format!=='luckybuy-table-snapshot-v1'||!backup.tables?.users)throw new Error('Unsupported snapshot');
const {default:pool,initDB}=await import('../server/db.js');
try {
 const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
 if(tables.length)throw new Error('Destination is not empty. Refusing to overwrite any existing database.');
 await initDB({seed:false});
 const c=await pool.connect();
 try {
  await c.query('BEGIN');
  for(const [table,rows] of Object.entries(backup.tables)){
   if(!/^[a-z_]+$/.test(table)||!Array.isArray(rows))throw new Error('Invalid table');
   for(const row of rows){
    const keys=Object.keys(row);if(keys.some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid column');
    await c.query(`INSERT INTO "${table}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,keys.map(k=>row[k]));
   }
  }
  await c.query('COMMIT');
 } catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 console.log('Snapshot restored to the explicitly selected empty destination.');
} finally {await pool.end()}
