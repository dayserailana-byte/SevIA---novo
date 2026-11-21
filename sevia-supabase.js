/* SevIA SST 4.0 — camada de ligação com o Supabase.
 * Faz o sistema funcionar fora do Claude: banco (documentos), login, fotos (Storage),
 * downloads e IA (Edge Function "ia"). Lê a configuração de config.js. */
(function () {
  "use strict";
  var CFG = window.SEVIA_CONFIG || {};
  window.SEVIA_SUPABASE = true;
  window.SEVIA_BLOB = CFG.url + "/storage/v1/object/public/sevia-fotos/";
  var sb = window.supabase.createClient(CFG.url, CFG.anonKey);
  var BUCKET = "sevia-fotos";
  var perfil = null;     // linha da tabela perfis
  var listeners = [];

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function toLogin() { location.replace("login.html"); return new Promise(function () {}); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function wrapDoc(id, d) { return { id: id, exists: d != null, data: function () { return clone(d); } }; }

  /* ---------- sessão e perfil ---------- */
  /* ---------- modo sem internet (etapa 1: abrir e consultar) ---------- */
  var CK = "sevia.perfil", semSinal = false;
  function semRede(e) {
    var m = String((e && (e.message || e.name)) || e || "");
    return !navigator.onLine || /fetch|network|load failed|timeout|offline/i.test(m);
  }
  function temSessaoLocal() {
    try { for (var i = 0; i < localStorage.length; i++) { if (/^sb-.*-auth-token$/.test(localStorage.key(i))) return true; } } catch (e) {}
    return false;
  }
  function perfilGuardado() { try { return JSON.parse(localStorage.getItem(CK) || "null"); } catch (e) { return null; } }
  var IDB = (function () {
    var p = null;
    function abre() {
      if (p) return p;
      p = new Promise(function (res, rej) {
        var q = indexedDB.open("sevia", 1);
        q.onupgradeneeded = function () { q.result.createObjectStore("kv"); };
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
      return p;
    }
    function tx(modo, fn) {
      return abre().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction("kv", modo), r = fn(t.objectStore("kv"));
          t.oncomplete = function () { res(r && r.result); };
          t.onerror = t.onabort = function () { rej(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx("readonly", function (s) { return s.get(k); }).catch(function () { return undefined; }); },
      set: function (k, v) { return tx("readwrite", function (s) { return s.put(v, k); }).catch(function () {}); }
    };
  })();
  function faixa() {
    var el = document.getElementById("sevia-offline");
    if (!navigator.onLine || semSinal) {
      if (!el) {
        el = document.createElement("div"); el.id = "sevia-offline"; el.setAttribute("role", "status");
        el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99998;background:#7a1f12;color:#fff;font:14px/1.35 system-ui,sans-serif;padding:8px 14px;text-align:center";
        el.textContent = "Sem internet: você pode consultar o que já foi aberto. Salvar, enviar fotos e a IA precisam de sinal.";
        (document.body || document.documentElement).appendChild(el);
      }
    } else if (el) { el.remove(); }
  }
  window.addEventListener("online", function () { semSinal = false; faixa(); listeners.slice().forEach(function (f) { f(); }); });
  window.addEventListener("offline", faixa);
  document.addEventListener("DOMContentLoaded", faixa);
  var ready = (async function () {
    var s;
    try { s = await sb.auth.getSession(); } catch (e) { s = { data: { session: null }, error: e }; }
    var g = perfilGuardado();
    if (!s.data.session) {
      if (g && temSessaoLocal() && (semRede(s.error) || !navigator.onLine)) {
        perfil = g; semSinal = true; faixa();
        window.SEVIA_PERFIL = perfil.perfil;
        window.SEVIA_EU = { nome: perfil.nome || "", funcao: perfil.funcao || "", registro: perfil.registro_prof || "" };
        return true;
      }
      return toLogin();
    }
    var uid = s.data.session.user.id;
    var r = await sb.from("sevia_perfis").select("*").eq("id", uid).maybeSingle();
    if (!r.data && r.error && g && g.id === uid && semRede(r.error)) { r = { data: g }; semSinal = true; faixa(); }
    if (!r.data || !r.data.ativo || r.data.trocar_senha) { await sb.auth.signOut(); try { localStorage.removeItem(CK); } catch (e) {} return toLogin(); }
    perfil = r.data;
    try { localStorage.setItem(CK, JSON.stringify(perfil)); } catch (e) {}
    window.SEVIA_PERFIL = perfil.perfil;
    window.SEVIA_EU = { nome: perfil.nome || "", funcao: perfil.funcao || "", registro: perfil.registro_prof || "" };
    return true;
  })();
  var ehAdmin = function () { return perfil && (perfil.perfil === "Administradora" || perfil.perfil === "Técnico ADM"); };
  var ehEditor = function () { return perfil && (perfil.perfil === "Administradora" || perfil.perfil === "Técnico ADM" || perfil.perfil === "Técnico SST"); };

  /* ---------- perfis -> "usuarios" do app ---------- */
  function usuarioDe(r) {
    return { id: r.id, nome: r.nome, usuario: r.usuario, email: r.email || "", telefone: r.telefone || "",
      perfil: r.perfil, funcao: r.funcao || "", registroProf: r.registro_prof || "", empresaId: r.empresa_id || "", empresasAcesso: r.empresas_acesso || [], ativo: r.ativo,
      status: r.trocar_senha ? "Aguardando primeiro acesso" : "Ativo", trocarSenha: r.trocar_senha,
      atualizadoEm: new Date(r.criado_em).getTime() };
  }
  async function fnErro(error) {
    try { var j = await error.context.json(); return new Error(j.erro || j.message || "Falha no servidor."); }
    catch (e) { return new Error(error.message || "Falha no servidor."); }
  }
  async function chamar(nome, corpo) {
    var r = await sb.functions.invoke(nome, { body: corpo });
    if (r.error) throw await fnErro(r.error);
    if (r.data && r.data.erro) throw new Error(r.data.erro);
    return r.data;
  }
  window.SEVIA_API = {
    criarUsuario: async function (p) {
      var d = await chamar("admin-usuarios", { acao: "criar", nome: p.nome, email: p.email, telefone: p.telefone, perfil: p.perfil, funcao: p.funcao || "", registro_prof: p.registroProf || "", empresa_id: p.empresaId || null, empresas_acesso: p.empresasAcesso || [] });
      return { id: d.id, usuario: d.usuario, senha: d.senha_provisoria };
    },
    atualizarUsuario: function (id, p) {
      return chamar("admin-usuarios", { acao: "atualizar", id: id, nome: p.nome, email: p.email, telefone: p.telefone, perfil: p.perfil, funcao: p.funcao || "", registro_prof: p.registroProf || "", empresa_id: p.empresaId || null, empresas_acesso: p.empresasAcesso || [], ativo: p.ativo });
    },
    resetarUsuario: async function (id) {
      var d = await chamar("admin-usuarios", { acao: "resetar", id: id });
      return { senha: d.senha_provisoria };
    },
    excluirUsuario: function (id) { return chamar("admin-usuarios", { acao: "excluir", id: id }); }
  };

  /* ---------- banco de documentos ---------- */
  function notificar() { listeners.slice().forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }

  async function lerColecao(col) {
    if (col === "usuarios") {
      if (!perfil || perfil.perfil !== "Administradora") return [];
      var u;
      try { u = await sb.from("sevia_perfis").select("*").order("nome"); } catch (e) { u = { error: e }; }
      if (u.error) {
        if (semRede(u.error)) { var cu = await IDB.get("c:usuarios"); semSinal = true; faixa(); return cu || []; }
        throw u.error;
      }
      var LU = u.data.map(function (r) { return { id: r.id, d: usuarioDe(r) }; });
      IDB.set("c:usuarios", LU);
      return LU;
    }
    var r;
    try { r = await sb.from("sevia_documentos").select("path,dados").eq("colecao", col); }
    catch (e) { r = { error: e }; }
    if (r.error) {
      var c = semRede(r.error) ? await IDB.get("c:" + col) : undefined;
      if (semRede(r.error)) { semSinal = true; faixa(); return c || []; }
      throw r.error;
    }
    var L = r.data.map(function (x) { return { id: x.path.slice(col.length + 1), d: x.dados }; });
    IDB.set("c:" + col, L);
    return L;
  }
  async function lerDoc(path) {
    if (path === "config/acessos") {
      var us = {};
      if (perfil && perfil.perfil === "Cliente") us[perfil.id] = { nome: perfil.nome, empresaId: perfil.empresa_id || "" };
      return { usuarios: us };
    }
    var r;
    try { r = await sb.from("sevia_documentos").select("dados").eq("path", path).maybeSingle(); }
    catch (e) { r = { error: e }; }
    if (r.error) {
      var c = semRede(r.error) ? await IDB.get("d:" + path) : undefined;
      if (semRede(r.error)) { semSinal = true; faixa(); return c === undefined ? null : c; }
      throw r.error;
    }
    IDB.set("d:" + path, r.data ? r.data.dados : null);
    return r.data ? r.data.dados : null;
  }
  function podeEscrever(col) { if (col === "usuarios") return false; return ehEditor(); }

  function docRef(path) {
    var col = path.split("/")[0], id = path.slice(col.length + 1);
    return {
      id: id, path: path,
      get: async function () { return wrapDoc(id, await lerDoc(path)); },
      set: async function (v) {
        if (!podeEscrever(col)) throw { code: "not_granted", message: "Sem permissão para gravar." };
        if (!navigator.onLine) throw { code: "offline", message: "Sem internet. Para salvar é preciso ter sinal." };
        var r = await sb.from("sevia_documentos").upsert({ path: path, colecao: col, dados: clone(v), atualizado_em: new Date().toISOString() });
        if (r.error) throw semRede(r.error) ? { code: "offline", message: "Sem internet. Para salvar é preciso ter sinal." } : r.error; notificar();
      },
      update: async function (v) {
        var atual = (await lerDoc(path)) || {};
        return this.set(Object.assign({}, atual, clone(v)));
      },
      delete: async function () {
        if (!podeEscrever(col)) throw { code: "not_granted", message: "Sem permissão para excluir." };
        var r = await sb.from("sevia_documentos").delete().eq("path", path);
        if (r.error) throw r.error; notificar();
      },
      onSnapshot: function (cb, err) {
        var vivo = true, ultimo = null;
        async function rodar() {
          try { var d = await lerDoc(path); var s = JSON.stringify(d); if (vivo && s !== ultimo) { ultimo = s; cb(wrapDoc(id, d)); } }
          catch (e) { if (vivo && err) err(e); }
        }
        listeners.push(rodar); rodar();
        var ch = sb.channel("d-" + path + "-" + uuid()).on("postgres_changes", { event: "*", schema: "public", table: "sevia_documentos", filter: "path=eq." + path }, rodar).subscribe();
        return function () { vivo = false; listeners = listeners.filter(function (f) { return f !== rodar; }); sb.removeChannel(ch); };
      }
    };
  }
  function colRef(col) {
    return {
      doc: function (id) { return docRef(col + "/" + (id || uuid())); },
      get: async function () { var L = await lerColecao(col); return { docs: L.map(function (x) { return { id: x.id, data: function () { return clone(x.d); } }; }) }; },
      onSnapshot: function (cb, err) {
        var vivo = true, ultimo = null;
        async function rodar() {
          try {
            var L = await lerColecao(col), s = JSON.stringify(L);
            if (vivo && s !== ultimo) { ultimo = s; cb({ docs: L.map(function (x) { return { id: x.id, data: function () { return clone(x.d); } }; }) }); }
          } catch (e) { if (vivo && err) err(e); }
        }
        listeners.push(rodar); rodar();
        var tabela = col === "usuarios" ? "sevia_perfis" : "sevia_documentos";
        var filtro = col === "usuarios" ? undefined : "colecao=eq." + col;
        var cfg = { event: "*", schema: "public", table: tabela }; if (filtro) cfg.filter = filtro;
        var ch = sb.channel("c-" + col + "-" + uuid()).on("postgres_changes", cfg, rodar).subscribe();
        return function () { vivo = false; listeners = listeners.filter(function (f) { return f !== rodar; }); sb.removeChannel(ch); };
      }
    };
  }
  var db = { doc: docRef, collection: colRef };

  /* ---------- fotos (Storage) ---------- */
  var assets = {
    upload: async function (blob, o) {
      var tipo = (o && o.type) || blob.type || "image/jpeg";
      var ext = ({ "image/png": "png", "image/webp": "webp" })[tipo] || "jpg";
      var id = uuid() + "." + ext;
      if (!navigator.onLine) throw { code: "offline", message: "Sem internet. Para enviar fotos é preciso ter sinal." };
      var r = await sb.storage.from(BUCKET).upload(id, blob, { contentType: tipo, upsert: false });
      if (r.error) throw { code: "upload_failed", message: r.error.message };
      return { id: id, url: window.SEVIA_BLOB + id, sizeBytes: blob.size, contentType: tipo };
    },
    delete: async function (id) { await sb.storage.from(BUCKET).remove([id]); }
  };

  /* ---------- downloads ---------- */
  var downloads = {
    save: async function (r) {
      var d = r.data, blob = d instanceof Blob ? d : new Blob([d]);
      var a = document.createElement("a"), url = URL.createObjectURL(blob);
      a.href = url; a.download = r.filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
      return { status: "saved" };
    }
  };

  /* ---------- IA (Edge Function "ia") ---------- */
  function b64(blob) {
    return new Promise(function (res, rej) {
      var f = new FileReader();
      f.onload = function () { var s = String(f.result); res({ media_type: blob.type || "image/jpeg", data: s.slice(s.indexOf(",") + 1) }); };
      f.onerror = function () { rej(new Error("leitura")); };
      f.readAsDataURL(blob);
    });
  }
  function achaJson(t) {
    t = String(t || "").replace(/```json|```/gi, "");
    var a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw { code: "bad_json", message: "A IA não devolveu dados válidos.", text: t };
    return JSON.parse(t.slice(a, b + 1));
  }
  async function pergunta(input, opts, json) {
    opts = opts || {};
    var prompt = typeof input === "string" ? input : input.map(function (m) { return m.role + ": " + m.content; }).join("\n");
    var imgs = await Promise.all((opts.images || []).map(b64));
    var corpo = { prompt: prompt, images: imgs, json: !!json };
    var chamada = sb.functions.invoke("ia", { body: corpo });
    var cancel = new Promise(function (_, rej) {
      if (opts.signal) opts.signal.addEventListener("abort", function () { rej({ code: "cancelled", message: "Cancelado." }); });
    });
    var r = await Promise.race([chamada, cancel]);
    if (r.error) { var e = await fnErro(r.error); throw { code: "ai_failed", message: e.message }; }
    if (r.data && r.data.erro) throw { code: "ai_failed", message: r.data.erro };
    return r.data.text || "";
  }
  var sample = async function (input, opts) { return { text: await pergunta(input, opts, false), truncated: false }; };
  sample.json = async function (input, opts) { return achaJson(await pergunta(input, opts, true)); };
  sample.limits = async function () { return { images: true }; };

  /* ---------- usuário ---------- */
  var user = {
    isOwner: async function () { return ehAdmin(); },
    canEdit: async function () { return ehEditor(); },
    me: async function () { return { id: perfil.id, name: perfil.nome }; },
    id: function () { return perfil.id; },
    profiles: async function () { return {}; },
    search: async function () { return []; }
  };

  window.claude = {
    use: async function (nome) {
      await ready;
      if (nome === "db") return db;
      if (nome === "assets") return ehEditor() ? assets : null;
      if (nome === "downloads") return downloads;
      if (nome === "sample") return ehEditor() ? sample : null;
      if (nome === "user") return user;
      return null;
    }
  };
  /* ---------- garante que o sistema abre sem internet ---------- */
  (function () {
    if (!("serviceWorker" in navigator) || !window.caches) return;
    var CV = "sevia-v2";
    var LOC = ["/", "/login", "/config.js", "/sevia-supabase.js", "/manifest.webmanifest", "/icon-192.png"];
    var CDNS = [
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js",
      "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
      "https://cdn.jsdelivr.net/npm/docx@9.8.1/dist/index.iife.js",
      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
    ];
    function aviso(t) {
      var el = document.createElement("div");
      el.style.cssText = "position:fixed;left:12px;right:12px;bottom:14px;z-index:99997;background:#14532d;color:#fff;font:14px/1.35 system-ui,sans-serif;padding:10px 14px;border-radius:10px;text-align:center";
      el.textContent = t; document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 6000);
    }
    async function garante() {
      try {
        await navigator.serviceWorker.ready;
        if (!navigator.onLine) return;
        var c = await caches.open(CV), falta = 0;
        for (var i = 0; i < LOC.length; i++) {
          if (!(await c.match(LOC[i], { ignoreSearch: true }))) {
            try { var r = await fetch(LOC[i], { cache: "reload" }); if (r.ok && !r.redirected) await c.put(LOC[i], r); else falta++; } catch (e) { falta++; }
          }
        }
        for (var j = 0; j < CDNS.length; j++) {
          if (!(await c.match(CDNS[j]))) {
            try { var r2 = await fetch(CDNS[j], { mode: "no-cors" }); await c.put(CDNS[j], r2); } catch (e) { falta++; }
          }
        }
        var ok = !falta && navigator.serviceWorker.controller;
        var antes = localStorage.getItem("sevia.offlineOk") === CV;
        if (ok && !antes) { localStorage.setItem("sevia.offlineOk", CV); aviso("Pronto: o SevIA já abre sem internet neste aparelho."); }
        if (!ok) console.warn("SevIA offline: faltam arquivos guardados ou o service worker ainda não assumiu. Recarregue a página.");
      } catch (e) { console.warn("SevIA offline:", e); }
    }
    window.addEventListener("load", function () { setTimeout(garante, 2500); });
  })();
  window.SEVIA_SAIR = async function () {
    try { localStorage.removeItem(CK); } catch (e) {}
    try { await sb.auth.signOut(); } catch (e) {}
    location.replace("login.html");
  };
})();
