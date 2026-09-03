import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import twilio from 'twilio';
import crypto from 'crypto';

const app=express();
app.use(express.json({limit:'16kb'}));
app.use(express.static('public'));
const db=new Database('bot.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, phone TEXT UNIQUE, created_at TEXT);
CREATE TABLE IF NOT EXISTS configs(user_id INTEGER PRIMARY KEY, market_id TEXT, trigger REAL, direction TEXT, outcome TEXT, amount_inr REAL, active INTEGER DEFAULT 0, last_event_id TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, user_id INTEGER, received_at TEXT, price REAL, trigger REAL, direction TEXT, outcome TEXT, amount_inr REAL, status TEXT, detail TEXT);`);

const PORT=Number(process.env.PORT||3000);
const JWT_SECRET=process.env.JWT_SECRET;
if(!JWT_SECRET) throw new Error('JWT_SECRET is required');
const live=String(process.env.LIVE_TRADING).toLowerCase()==='true';

const otpMem=new Map();
function token(user){return jwt.sign({uid:user.id,phone:user.phone},JWT_SECRET,{expiresIn:'7d'});}
function auth(req,res,next){try{const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))throw 0;req.user=jwt.verify(h.slice(7),JWT_SECRET);next()}catch{res.status(401).json({error:'Unauthorized'})}}
function user(req){return db.prepare('SELECT * FROM users WHERE id=?').get(req.user.uid)}
function config(uid){return db.prepare('SELECT * FROM configs WHERE user_id=?').get(uid)}
function saveConfig(uid,c){db.prepare(`INSERT INTO configs(user_id,market_id,trigger,direction,outcome,amount_inr,active,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now'))
ON CONFLICT(user_id) DO UPDATE SET market_id=excluded.market_id,trigger=excluded.trigger,direction=excluded.direction,outcome=excluded.outcome,amount_inr=excluded.amount_inr,active=excluded.active,updated_at=excluded.updated_at`)
.run(uid,c.market_id,c.trigger,c.direction,c.outcome,c.amount_inr,c.active?1:0)}

app.post('/api/auth/send-otp',async(req,res)=>{
  const phone=String(req.body.phone||'').trim();
  if(!/^\+\d{8,15}$/.test(phone)) return res.status(400).json({error:'Use international format, e.g. +919876543210'});
  if(process.env.TWILIO_VERIFY_SERVICE_SID){
    const client=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID).verifications.create({to:phone,channel:'sms'});
    return res.json({ok:true});
  }
  const code=String(Math.floor(100000+Math.random()*900000));
  otpMem.set(phone,{code,expires:Date.now()+5*60*1000});
  console.log(`[DEV OTP] ${phone}: ${code}`);
  res.json({ok:true,developmentOtp:process.env.NODE_ENV==='production'?undefined:code});
});
app.post('/api/auth/verify-otp',async(req,res)=>{
  const phone=String(req.body.phone||'').trim(), code=String(req.body.code||'').trim();
  let ok=false;
  if(process.env.TWILIO_VERIFY_SERVICE_SID){
    const client=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
    const r=await client.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID).verificationChecks.create({to:phone,code});
    ok=r.status==='approved';
  }else{
    const x=otpMem.get(phone); ok=!!x&&x.expires>Date.now()&&x.code===code; otpMem.delete(phone);
  }
  if(!ok)return res.status(401).json({error:'Invalid or expired OTP'});
  let u=db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if(!u){const r=db.prepare('INSERT INTO users(phone,created_at) VALUES(?,datetime("now"))').run(phone);u={id:r.lastInsertRowid,phone}}
  res.json({token:token(u)});
});

app.get('/api/config',auth,(req,res)=>{
  const c=config(req.user.uid)||{market_id:process.env.PREDIK_MARKET_ID||'',trigger:78500,direction:'above',outcome:'YES',amount_inr:200,active:0};
  res.json({...c,liveTrading:live});
});
app.post('/api/config',auth,(req,res)=>{
  const c=req.body;
  const trigger=Number(c.trigger), amount=Number(c.amount_inr);
  if(!Number.isFinite(trigger)||trigger<=0) return res.status(400).json({error:'Invalid trigger'});
  if(!['above','below'].includes(c.direction)||!['YES','NO'].includes(c.outcome)) return res.status(400).json({error:'Invalid direction/outcome'});
  if(!Number.isFinite(amount)||amount<1||amount>Number(process.env.MAX_INR_ORDER||2000)) return res.status(400).json({error:'Amount outside safety limit'});
  saveConfig(req.user.uid,{market_id:String(c.market_id||''),trigger,direction:c.direction,outcome:c.outcome,amount_inr:amount,active:Boolean(c.active)});
  res.json(config(req.user.uid));
});
app.post('/api/stop',auth,(req,res)=>{const c=config(req.user.uid);if(c)db.prepare('UPDATE configs SET active=0 WHERE user_id=?').run(req.user.uid);res.json({ok:true})});

async function predikTrade(c,eventId){
  if(!process.env.PREDIK_API_KEY) throw new Error('PREDIK_API_KEY not configured');
  if(!c.market_id) throw new Error('Predik market ID not configured');
  const usd=Number(c.amount_inr)/Number(process.env.USD_INR_RATE||90);
  if(usd<1) throw new Error('Converted amount is below Predik minimum of 1 USDC');
  const base='https://app.predik.io/api/v2';
  const headers={'Authorization':`Bearer ${process.env.PREDIK_API_KEY}`,'Content-Type':'application/json'};
  const m=await fetch(`${base}/markets/${c.market_id}`,{headers}).then(async r=>{if(!r.ok)throw new Error(`Market lookup ${r.status}`);return r.json()});
  if(m.state!=='Live')throw new Error(`Market is not Live: ${m.state}`);
  const outcomeIndex=c.outcome==='YES'?0:1;
  const amount=usd.toFixed(2);
  const q=await fetch(`${base}/markets/${c.market_id}/quote-lock`,{method:'POST',headers,body:JSON.stringify({side:'BUY',outcomeIndex,amount})}).then(async r=>{if(!r.ok)throw new Error(`Quote lock ${r.status}`);return r.json()});
  await fetch(`${base}/markets/${c.market_id}/session?refresh=1`,{method:'POST',headers});
  await new Promise(r=>setTimeout(r,1500));
  const idem=eventId;
  const t=await fetch(`${base}/markets/${c.market_id}/trade`,{method:'POST',headers:{...headers,'x-idempotency-key':idem},body:JSON.stringify({side:'BUY',outcomeIndex,amount,quoteId:q.quoteId})});
  const body=await t.json();
  if(!t.ok)throw new Error(body.message||body.error||`Trade ${t.status}`);
  return body;
}

app.post('/api/webhook/tradingview',async(req,res)=>{
  const secret=String(req.headers['x-webhook-secret']||'');
  if(!process.env.TRADINGVIEW_WEBHOOK_SECRET||secret!==process.env.TRADINGVIEW_WEBHOOK_SECRET)return res.status(401).json({error:'Unauthorized'});
  const uid=Number(req.body.userId), price=Number(req.body.price), eventId=String(req.body.eventId||crypto.randomUUID());
  const c=config(uid);
  if(!c||!c.active)return res.status(200).json({ok:true,ignored:'bot inactive'});
  const crossed=c.direction==='above'?price>=c.trigger:price<=c.trigger;
  if(!crossed)return res.status(200).json({ok:true,ignored:'threshold not met'});
  if(c.last_event_id===eventId)return res.status(200).json({ok:true,duplicate:true});
  db.prepare('UPDATE configs SET active=0,last_event_id=? WHERE user_id=?').run(eventId,uid);
  let status='TEST_TRIGGERED',detail='No real order sent (LIVE_TRADING=false)';
  if(live){try{const trade=await predikTrade(c,eventId);status='EXECUTED';detail=JSON.stringify(trade)}catch(e){status='ERROR';detail=e.message}}
  db.prepare('INSERT INTO events(id,user_id,received_at,price,trigger,direction,outcome,amount_inr,status,detail) VALUES(?,?,datetime("now"),?,?,?,?,?,?,?)')
  .run(eventId,uid,price,c.trigger,c.direction,c.outcome,c.amount_inr,status,detail);
  res.json({ok:true,status,detail});
});

app.get('/api/events',auth,(req,res)=>res.json(db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY received_at DESC LIMIT 50').all(req.user.uid)));
app.listen(PORT,()=>console.log(`Bot running on http://localhost:${PORT} — live=${live}`));
