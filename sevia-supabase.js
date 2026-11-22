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
    function faixaChaves(prefixo) { return IDBKeyRange.bound(prefixo, prefixo + "\uffff"); }
    return {
      get: function (k) { return tx("readonly", function (s) { return s.get(k); }).catch(function () { return undefined; }); },
      set: function (k, v) { return tx("readwrite", function (s) { return s.put(v, k); }).catch(function () {}); },
      put: function (k, v) { return tx("readwrite", function (s) { return s.put(v, k); }); },
      del: function (k) { return tx("readwrite", function (s) { return s.delete(k); }).catch(function () {}); },
      count: function (prefixo) { return tx("readonly", function (s) { return s.count(faixaChaves(prefixo)); }).then(function (n) { return n || 0; }).catch(function () { return 0; }); },
      all: function (prefixo) {
        return abre().then(function (db) {
          return new Promise(function (res, rej) {
            var t = db.transaction("kv", "readonly"), out = [], q = t.objectStore("kv").openCursor(faixaChaves(prefixo));
            q.onsuccess = function () { var c = q.result; if (c) { out.push({ k: c.key, v: c.value }); c.continue(); } };
            t.oncomplete = function () { res(out); };
            t.onerror = t.onabort = function () { rej(t.error); };
          });
        }).catch(function () { return []; });
      }
    };
  })();
  window.SEVIA_LOCAL = {};   // fotos ainda não enviadas: id -> endereço local
  var pend = { fotos: 0, docs: 0 }, enviando = false;
  function avisoTela(t, cor) {
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;left:12px;right:12px;bottom:76px;z-index:99997;background:" + (cor || "#14532d") + ";color:#fff;font:14px/1.35 system-ui,sans-serif;padding:10px 14px;border-radius:10px;text-align:center";
    el.textContent = t; (document.body || document.documentElement).appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }
  async function pendencias() {
    pend.fotos = await IDB.count("p:"); pend.docs = await IDB.count("o:"); faixa();
  }
  function faixa() {
    var el = document.getElementById("sevia-offline"), off = !navigator.onLine || semSinal, n = pend.docs + pend.fotos;
    var html = document.documentElement;
    if (!off && !n) { if (el) el.remove(); html.classList.remove("sevia-faixa"); return; }
    if (!document.getElementById("sevia-faixa-css")) {
      var st = document.createElement("style"); st.id = "sevia-faixa-css";
      st.textContent = "html.sevia-faixa body{padding-bottom:64px}html.sevia-faixa .savebar{bottom:60px}";
      (document.head || html).appendChild(st);
    }
    if (!el) {
      el = document.createElement("div"); el.id = "sevia-offline"; el.setAttribute("role", "status");
      el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99998;color:#fff;font:14px/1.35 system-ui,sans-serif;padding:8px 14px;text-align:center";
      (document.body || html).appendChild(el);
    }
    html.classList.add("sevia-faixa");
    var fila = n ? "Aguardando envio: " + pend.docs + (pend.docs === 1 ? " relatório" : " relatórios") + " e " + pend.fotos + (pend.fotos === 1 ? " foto." : " fotos.") : "";
    el.style.background = off ? "#7a1f12" : "#8a5a00";
    if (off) { el.textContent = "Sem internet. " + (fila ? fila + " Serão enviados quando houver sinal." : "Você pode consultar o que já foi aberto; a IA precisa de sinal."); }
    else {
      el.textContent = (enviando ? "Enviando… " : "") + fila + " ";
      if (!enviando) { var b = document.createElement("button"); b.type = "button"; b.textContent = "Enviar agora"; b.style.cssText = "margin-left:6px;padding:4px 10px;border-radius:8px;border:1px solid #fff;background:transparent;color:#fff;font:inherit"; b.onclick = function () { enviar(); }; el.appendChild(b); }
    }
  }
  window.addEventListener("online", function () { semSinal = false; faixa(); listeners.slice().forEach(function (f) { f(); }); setTimeout(enviar, 1500); });
  window.addEventListener("offline", faixa);
  document.addEventListener("DOMContentLoaded", faixa);
  function usaGuardado(g) {
    perfil = g; semSinal = true; faixa();
    window.SEVIA_PERFIL = perfil.perfil;
    window.SEVIA_EU = { nome: perfil.nome || "", funcao: perfil.funcao || "", registro: perfil.registro_prof || "" };
    return true;
  }
  var ready0 = (async function () {
    var g = perfilGuardado();
    /* sem sinal: usa o perfil guardado na hora (o login do Supabase ficaria tentando renovar a sessão por vários segundos) */
    if (!navigator.onLine && g && temSessaoLocal()) return usaGuardado(g);
    var s;
    try { s = await sb.auth.getSession(); } catch (e) { s = { data: { session: null }, error: e }; }
    if (!s.data.session) {
      if (g && temSessaoLocal() && (semRede(s.error) || !navigator.onLine)) return usaGuardado(g);
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
  async function carregaPendentes() {
    var L = await IDB.all("p:");
    L.forEach(function (x) { if (x.v && x.v.blob) window.SEVIA_LOCAL[x.v.id] = URL.createObjectURL(x.v.blob); });
    await pendencias();
  }
  var ready = ready0.then(async function (v) {
    try { await carregaPendentes(); } catch (e) {}
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    setTimeout(enviar, 2000);
    return v;
  });
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

  async function sobrepoe(col, L) {
    var O = await IDB.all("o:" + col + "/");
    if (!O.length) return L;
    var m = {}, ordem = [];
    L.forEach(function (x) { m[x.id] = x; ordem.push(x.id); });
    O.forEach(function (e) {
      var id = e.v.path.slice(col.length + 1);
      if (e.v.del) { delete m[id]; ordem = ordem.filter(function (k) { return k !== id; }); }
      else { if (!m[id]) ordem.push(id); m[id] = { id: id, d: e.v.dados }; }
    });
    return ordem.map(function (k) { return m[k]; });
  }
  async function lerColecao(col) {
    if (col === "usuarios") {
      if (!perfil || (perfil.perfil !== "Administradora" && perfil.perfil !== "Técnico ADM")) return [];
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
      if (semRede(r.error)) { semSinal = true; faixa(); return sobrepoe(col, c || []); }
      throw r.error;
    }
    var L = r.data.map(function (x) { return { id: x.path.slice(col.length + 1), d: x.dados }; });
    IDB.set("c:" + col, L);
    if (semSinal && navigator.onLine) { semSinal = false; faixa(); }
    return sobrepoe(col, L);
  }
  async function lerDoc(path) {
    if (path === "config/acessos") {
      var us = {};
      if (perfil && perfil.perfil === "Cliente") us[perfil.id] = { nome: perfil.nome, empresaId: perfil.empresa_id || "" };
      return { usuarios: us };
    }
    var pe = await IDB.get("o:" + path);
    if (pe) return pe.del ? null : pe.dados;
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

  /* sem sinal: guarda no aparelho e envia depois */
  async function guardaDoc(path, col, v, apagar) {
    var id = path.slice(col.length + 1), d = apagar ? null : clone(v);
    var lista = (await IDB.get("c:" + col)) || [];
    if (apagar) {
      var pe = await IDB.get("o:" + path), noServidor = lista.some(function (x) { return x.id === id; });
      if (pe && !noServidor) await IDB.del("o:" + path);          // nunca chegou ao servidor: só descarta
      else await IDB.put("o:" + path, { path: path, col: col, del: true, ts: Date.now() });
      IDB.set("c:" + col, lista.filter(function (x) { return x.id !== id; }));
    } else {
      if (col === "inspecoes") {
        var antigo = lista.filter(function (x) { return x.id === id; })[0];
        var numAntigo = antigo && antigo.d && antigo.d.numero;
        if (numAntigo > 0) d.numero = numAntigo;                   // já tem número: mantém
        else {
          d.criadoOffline = true;                                    // veio do campo sem internet
          if (!d.rascunho) { d.numero = 0; d._semNumero = true; if (!d.revisao) d.revisao = "pendente"; } // número sai ao enviar
        }
      }
      try { await IDB.put("o:" + path, { path: path, col: col, dados: d, ts: Date.now() }); }
      catch (e) { throw { code: "quota", message: "Sem espaço no aparelho para guardar o relatório." }; }
      var achou = false;
      lista = lista.map(function (x) { if (x.id === id) { achou = true; return { id: id, d: d }; } return x; });
      if (!achou) lista.push({ id: id, d: d });
      IDB.set("c:" + col, lista);
    }
    semSinal = !navigator.onLine || semSinal;
    await pendencias(); notificar();
    avisoTela("Salvo no aparelho. Será enviado quando houver sinal.", "#8a5a00");
  }
  /* envio dos pendentes (fotos primeiro, depois os relatórios) */
  async function proxNumeroServidor() {
    var r = await sb.from("sevia_documentos").select("dados").eq("colecao", "inspecoes");
    if (r.error) throw r.error;
    var mx = 0; r.data.forEach(function (x) { var n = x.dados && x.dados.numero; if (n > mx) mx = n; });
    return mx + 1;
  }
  async function enviar() {
    if (enviando || !navigator.onLine || !perfil || !ehEditor()) return;
    enviando = true; faixa();
    var feito = 0;
    try {
      var F = await IDB.all("p:");
      for (var i = 0; i < F.length; i++) {
        var f = F[i].v, r;
        try { r = await sb.storage.from(BUCKET).upload(f.id, f.blob, { contentType: f.tipo, upsert: false }); } catch (e) { r = { error: e }; }
        if (r.error && !/exist|duplicate/i.test(String(r.error.message || ""))) { if (semRede(r.error)) return; console.warn("foto pendente:", r.error); continue; }
        await IDB.del(F[i].k); feito++;
      }
      if (await IDB.count("p:")) return;                           // ficou foto sem enviar: segura os relatórios
      var O = (await IDB.all("o:")).sort(function (a, b) { return (a.v.ts || 0) - (b.v.ts || 0); });
      for (var j = 0; j < O.length; j++) {
        var e2 = O[j].v, r2;
        try {
          if (e2.del) r2 = await sb.from("sevia_documentos").delete().eq("path", e2.path);
          else {
            var dd = e2.dados;
            if (dd._semNumero && !dd.rascunho) { dd.numero = await proxNumeroServidor(); }
            if (e2.col === "inspecoes" && (dd.criadoOffline || dd._semNumero) && !dd.rascunho && !dd.revisao) dd.revisao = "pendente";
            if (dd.numero > 0) delete dd._semNumero;
            r2 = await sb.from("sevia_documentos").upsert({ path: e2.path, colecao: e2.col, dados: dd, atualizado_em: new Date().toISOString() });
          }
        } catch (e) { r2 = { error: e }; }
        if (r2.error) { if (semRede(r2.error)) return; console.warn("relatório pendente:", r2.error); continue; }
        await IDB.del(O[j].k); feito++;
      }
    } finally {
      enviando = false; await pendencias();
      if (feito) { notificar(); if (!pend.docs && !pend.fotos) avisoTela("Tudo enviado.", "#14532d"); }
    }
  }
  function docRef(path) {
    var col = path.split("/")[0], id = path.slice(col.length + 1);
    return {
      id: id, path: path,
      get: async function () { return wrapDoc(id, await lerDoc(path)); },
      set: async function (v) {
        if (!podeEscrever(col)) throw { code: "not_granted", message: "Sem permissão para gravar." };
        if (!navigator.onLine) return guardaDoc(path, col, v, false);
        var r;
        try { r = await sb.from("sevia_documentos").upsert({ path: path, colecao: col, dados: clone(v), atualizado_em: new Date().toISOString() }); }
        catch (e) { r = { error: e }; }
        if (r.error) { if (semRede(r.error)) return guardaDoc(path, col, v, false); throw r.error; }
        await IDB.del("o:" + path); notificar();
      },
      update: async function (v) {
        var atual = (await lerDoc(path)) || {};
        return this.set(Object.assign({}, atual, clone(v)));
      },
      delete: async function () {
        if (!podeEscrever(col) || !ehAdmin()) throw { code: "not_granted", message: "Sem permissão para excluir." };
        if (!navigator.onLine) return guardaDoc(path, col, null, true);
        var r;
        try { r = await sb.from("sevia_documentos").delete().eq("path", path); } catch (e) { r = { error: e }; }
        if (r.error) { if (semRede(r.error)) return guardaDoc(path, col, null, true); throw r.error; }
        await IDB.del("o:" + path); notificar();
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
        /* reforço: se o tempo real falhar (sinal fraco, aba dormindo), reconsulta a cada 20 s e ao voltar à tela/rede */
        function reforco() { if (vivo && navigator.onLine && !document.hidden) rodar(); }
        var tm = setInterval(reforco, 20000);
        window.addEventListener("online", reforco); document.addEventListener("visibilitychange", reforco);
        return function () { vivo = false; clearInterval(tm); window.removeEventListener("online", reforco); document.removeEventListener("visibilitychange", reforco); listeners = listeners.filter(function (f) { return f !== rodar; }); sb.removeChannel(ch); };
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
      async function local() {
        try { await IDB.put("p:" + id, { id: id, blob: blob, tipo: tipo }); }
        catch (e) { throw { code: "quota", message: "Sem espaço no aparelho para guardar a foto." }; }
        window.SEVIA_LOCAL[id] = URL.createObjectURL(blob);
        await pendencias();
        return { id: id, url: window.SEVIA_LOCAL[id], sizeBytes: blob.size, contentType: tipo };
      }
      if (!navigator.onLine) return local();
      var r;
      try {
        r = await Promise.race([sb.storage.from(BUCKET).upload(id, blob, { contentType: tipo, upsert: false }),
          new Promise(function (res) { setTimeout(function () { res({ error: { message: "timeout" } }); }, 30000); })]);
      } catch (e) { r = { error: e }; }
      if (r.error) { if (semRede(r.error)) return local(); throw { code: "upload_failed", message: r.error.message }; }
      return { id: id, url: window.SEVIA_BLOB + id, sizeBytes: blob.size, contentType: tipo };
    },
    delete: async function (id) {
      if (window.SEVIA_LOCAL[id]) { try { URL.revokeObjectURL(window.SEVIA_LOCAL[id]); } catch (e) {} delete window.SEVIA_LOCAL[id]; await IDB.del("p:" + id); await pendencias(); return; }
      try { await sb.storage.from(BUCKET).remove([id]); } catch (e) {}
    }
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
    function aviso(t) { avisoTela(t, "#14532d"); }
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
