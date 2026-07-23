/**
 * Custom API Provider Extension for Oh My Pi
 *   /custom-api add | list | edit <id> | remove <id> | reload
 *
 * Pre-fetches models from /v1/models. contextWindow & maxTokens are auto-resolved
 * by OMP from its bundled catalog when model IDs match known models (e.g. gpt-5.1).
 * reasoning: true enables the built-in thinking level selector in /model.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfigs, saveConfigs, type CustomApiConfig } from "./store";

const KEYS = ["openai-completions","openai-responses","anthropic-messages","google-generative-ai"] as const;
const ZERO = { input:0, output:0, cacheRead:0, cacheWrite:0 } as const;
const SRC = "custom-api";
const keyMem = new Map<string,string>();
type MR = { registerProvider(p:string,c:object,s?:string):void; clearSourceRegistrations(s:string):void };
type UI = Record<string,Function>;

export default function(pi:ExtensionAPI) {
  let cfgs = loadC();
  function loadC() { try { return loadConfigs() } catch { return [] as CustomApiConfig[] } }
  for (const c of cfgs) { if (c.apiKey) keyMem.set(c.id,c.apiKey); try { pi.registerProvider(c.id,build(c)) } catch { } }

  function build(c:CustomApiConfig) {
    const k = keyMem.get(c.id) ?? (c.apiKeyEnvVar ? process.env[c.apiKeyEnvVar] : undefined);
    return {
      baseUrl:c.baseUrl, api:c.api, apiKey:k, authHeader:c.authHeader ?? true, headers:c.headers,
      models: c.models.map(m => ({
        id:m.id, name:m.name, reasoning:true, input:["text"], cost:ZERO,
      })),
      oauth: { name:c.name, async login() {
        const s = keyMem.get(c.id); if (s) return s;
        if (c.apiKeyEnvVar && process.env[c.apiKeyEnvVar]) return process.env[c.apiKeyEnvVar] as string;
        return "";
      }},
    };
  }

  async function fetchM(url:string, key:string) {
    try {
      const r = await fetch(url.replace(/\/+$/,"")+"/models", { headers:{ Authorization:"Bearer "+key } });
      if (!r.ok) return [] as {id:string,name:string}[];
      return ((await r.json()) as {data?:{id:string}[]}).data?.filter(m=>m.id).map(m=>({id:m.id,name:m.id})) ?? [];
    } catch { return [] as {id:string,name:string}[]; }
  }

  function mr(ctx:Record<string,unknown>) { return (ctx as {modelRegistry?:MR}).modelRegistry }
  function u(ctx:Record<string,unknown>) { return (ctx as {ui?:UI,hasUI?:boolean}).ui }

  pi.registerCommand("custom-api", {
    description:"Manage custom AI API providers",
    handler:async(a,ctx)=>{
      const p=split(a), c=p[0]?.toLowerCase();
      if (c==="add") await add(ctx);
      else if (c==="list"||c==="ls") list();
      else if (c==="edit") await edit(ctx,p.slice(1));
      else if (c==="remove"||c==="rm") await rem(ctx,p.slice(1));
      else if (c==="reload") { cfgs=loadC(); for (const x of cfgs) pi.registerProvider(x.id,build(x)); list(); }
      else help();
    },
  });

  async function add(ctx:Record<string,unknown>) {
    const ui = u(ctx); if (!ui||!(ctx as{hasUI?:boolean}).hasUI) return;
    cfgs=loadC();
    const id=(await ui.input("Provider ID","my-gateway")) as string|undefined; if(!id) return;
    if(cfgs.some((c:CustomApiConfig)=>c.id===id)) { ui.notify('"'+id+'" exists.',"error"); return; }
    const nm=(await ui.input("Display name","My Gateway")) as string|undefined; if(!nm) return;
    const ap=(await ui.select("API protocol",[...KEYS])) as string|undefined; if(!ap) return;
    const bu=(await ui.input("Base URL (include /v1)","https://api.example.com/v1")) as string|undefined; if(!bu) return;
    const rk=(await ui.input("API key","sk-... or ENV_VAR")) as string|undefined;
    let ev:string|undefined, sk:string|undefined;
    if(rk) { if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(rk)) ev=rk; else { sk=rk; keyMem.set(id,rk); } }
    const key=sk??(ev?process.env[ev]:undefined);
    const ms=key?await fetchM(bu,key):[];
    if(ms.length>0) ui.notify("Found "+ms.length+" model(s).","info");
    const cfg:CustomApiConfig={id,name:nm,baseUrl:bu,api:ap,apiKeyEnvVar:ev,apiKey:sk,authHeader:true,models:ms,createdAt:new Date().toISOString()};
    cfgs.push(cfg); saveConfigs(cfgs);
    const m=mr(ctx); if(m) m.registerProvider(cfg.id,build(cfg),SRC+":"+cfg.id);
    list();
  }

  function list() {
    if(cfgs.length===0) { msg("No providers."); return; }
    msg("Providers:\n"+cfgs.map((c:CustomApiConfig)=>"  "+c.id+" "+c.name+" "+c.baseUrl+" "+((c.apiKey||c.apiKeyEnvVar)?"✓":"✗")).join("\n"));
  }

  async function edit(ctx:Record<string,unknown>,args:string[]) {
    const ui=u(ctx); if(!ui||!(ctx as{hasUI?:boolean}).hasUI) return;
    const id=args[0]; if(!id) { ui.notify("Usage: /custom-api edit <id>","error"); return; }
    const c=cfgs.find((x:CustomApiConfig)=>x.id===id); if(!c) { ui.notify('"'+id+'" not found.',"error"); return; }
    const bu=(await ui.input("Base URL",c.baseUrl)) as string|undefined; if(bu) c.baseUrl=bu;
    const rk=(await ui.input("API key","sk-... or ENV_VAR")) as string|undefined;
    if(rk) { if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(rk)) { c.apiKeyEnvVar=rk; c.apiKey=undefined; keyMem.delete(id); } else { c.apiKey=rk; c.apiKeyEnvVar=undefined; keyMem.set(id,rk); } }
    const key=c.apiKey??(c.apiKeyEnvVar?process.env[c.apiKeyEnvVar]:undefined);
    const ms=key?await fetchM(c.baseUrl,key):[];
    if(ms.length>0) { c.models=ms; ui.notify("Found "+ms.length+" model(s).","info"); }
    saveConfigs(cfgs);
    const m=mr(ctx); if(m) m.registerProvider(c.id,build(c),SRC+":"+c.id);
    list();
  }

  async function rem(ctx:Record<string,unknown>,args:string[]) {
    const ui=u(ctx);
    const id=args[0]; if(!id) { ui?.notify?.("Usage: /custom-api remove <id>","error"); return; }
    const i=cfgs.findIndex((c:CustomApiConfig)=>c.id===id); if(i===-1) { ui?.notify?.('"'+id+'" not found.',"error"); return; }
    const ok=(ctx as{hasUI?:boolean}).hasUI&&ui?(await ui.confirm("Remove",'Delete "'+cfgs[i].name+'"?')) as boolean:true;
    if(ok) { cfgs.splice(i,1); saveConfigs(cfgs); keyMem.delete(id); const m=mr(ctx); if(m) m.clearSourceRegistrations(SRC+":"+id); list(); }
  }

  function help() { msg("/custom-api add | list | edit <id> | remove <id> | reload"); }
  function msg(s:string) { pi.sendMessage({customType:"ci",content:s,display:true,attribution:"user"},{triggerTurn:false}); }
}

function split(s:string):string[] {
  const o:string[]=[]; let c="",sq=false,dq=false;
  for(const ch of s) { if(sq) { if(ch==="'") sq=false; else c+=ch; } else if(dq) { if(ch==='"') dq=false; else c+=ch; } else if(ch==="'") sq=true; else if(ch==='"') dq=true; else if(ch===" "||ch==="\t") { if(c) { o.push(c); c=""; } } else c+=ch; }
  if(c) o.push(c); return o;
}
