// Restore rehearsal in a disposable local PostgreSQL WASM database, never a live server.
import {PGlite} from '@electric-sql/pglite';
if(!process.argv[2])throw new Error('Pass the private snapshot path');
process.env.DOTENV_CONFIG_PATH='__verify_no_env__';
process.env.DATABASE_URL='postgresql://invalid:invalid@127.0.0.1:1/unused';
process.env.RESTORE_DATABASE_URL=process.env.DATABASE_URL;
process.env.LOG_LEVEL='silent';
process.argv[3]='--empty-only';
const db=new PGlite();
const {default:pool}=await import('../server/db.js');
const query=async(sql,args)=>args?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
pool.query=query;pool.connect=async()=>({query,release(){}});
try{await import('./restore-database.mjs');console.log('Offline restore rehearsal passed. No live database was modified.')}finally{await db.close()}
