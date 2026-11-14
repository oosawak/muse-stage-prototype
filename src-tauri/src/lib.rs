// muse-stage：VRM のミューズが、返事のテキストを読み上げて口パクする出力専用アプリ。
// 読み上げは画面側（WebView）の speechSynthesis を先に試し、使えなければこの Rust 側の macOS `say` に逃がす。
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// いま読み上げている `say` のプロセス（止めるため）
struct Speaker(Mutex<Option<Child>>);

/// macOS の `say` で読み上げる。読み終わる（または止められる）まで待ってから返る
#[tauri::command]
async fn speak_say(state: tauri::State<'_, Speaker>, text: String, voice: String, rate: u32) -> Result<String, String> {
  // 前の読み上げが残っていれば止める
  if let Some(mut old) = state.0.lock().unwrap().take() { let _ = old.kill(); }
  let mut cmd = Command::new("/usr/bin/say");
  if !voice.is_empty() { cmd.args(["-v", &voice]); }
  if rate > 0 { cmd.args(["-r", &rate.to_string()]); }
  // テキストは引数ではなく標準入力で渡す（先頭が「-」でも安全なように）
  cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
  let mut child = cmd.spawn().map_err(|e| format!("say を起動できません: {e}"))?;
  {
    use std::io::Write;
    let mut stdin = child.stdin.take().ok_or("say の入力を開けません")?;
    stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
  }
  *state.0.lock().unwrap() = Some(child);
  // 終わるのを待つ（止められたときは、取り出されているので None になる）
  loop {
    std::thread::sleep(std::time::Duration::from_millis(60));
    let mut guard = state.0.lock().unwrap();
    match guard.as_mut() {
      None => return Ok("stopped".into()),
      Some(c) => match c.try_wait() {
        Ok(Some(st)) => { *guard = None; return if st.success() { Ok("done".into()) } else { Err(format!("say が終了コード {st} で止まりました")) }; }
        Ok(None) => continue,
        Err(e) => { *guard = None; return Err(e.to_string()); }
      },
    }
  }
}

/// `say` の読み上げを止める
#[tauri::command]
fn stop_say(state: tauri::State<'_, Speaker>) {
  if let Some(mut c) = state.0.lock().unwrap().take() { let _ = c.kill(); }
}

/// `say -v ?` から日本語の声の名前を返す
#[tauri::command]
fn ja_voices() -> Vec<String> {
  let out = Command::new("/usr/bin/say").args(["-v", "?"]).output();
  let Ok(out) = out else { return vec![] };
  String::from_utf8_lossy(&out.stdout).lines()
    .filter(|l| l.contains("ja_JP"))
    .filter_map(|l| l.split("  ").next().map(|s| s.trim().to_string()))
    .filter(|s| !s.is_empty())
    .collect()
}

/// 会話の1メッセージ（第2段の取り込み結果）
#[derive(serde::Serialize)]
struct ChatMsg { role: String, text: String }

/// 第2段の実験：Mac版ミューズアプリ（Muse.app）の窓に出ている会話を、アクセシビリティ経由で読む。
/// muse-stage にアクセシビリティの許可が要る（子プロセスの osascript への許可も必要な場合がある）。
/// 実機で分かったこと（2026-11-14）：
/// - Muse アプリでは `entire contents` が常に 0 件を返す。そのため子要素をレベルごとに聞く幅優先でたどる。
/// - 会話メッセージには2つの姿がある。古いものは「ユーザーメッセージ: 」「アシスタントメッセージ: 」の
///   接頭辞つきで1つの AXStaticText に全文が入る。新しいものは段落・コード片ごとにバラバラの要素に分かれ、
///   接頭辞が無い（ユーザーの発言だけ先頭に「自分:」の断片が付く）。接頭辞だけを探すと最新の返事を逃す。
/// - 画面に見えている範囲しかツリーに載らない。一番下までスクロールすると新しい返事が載ってくる。
/// そのため、要素の経路（パス）も一緒に集め、会話リストの子ごとにメッセージを組み立て直す。
/// 速さのため、まず会話リストの置き場所へ直行してその中だけをたどり、場所が違えば全窓の幅優先に落とす。
/// 返り値：会話のメッセージ一覧（古い順）。読めないときはエラーの文を返す
#[tauri::command]
async fn read_muse(app: String) -> Result<Vec<ChatMsg>, String> {
  let app = if app.is_empty() { "Muse".to_string() } else { app };
  // まず会話リストの置き場所（窓から /1/1/1/1/1/1/1/3/5、実機で安定）へ直行し、その中だけをたどる。
  // 全窓をたどるより要素数が半分以下になり、取り込みが速くなる。場所が違っていたら全窓の幅優先に落とす
  let script = r#"
on collectTexts(rootEl, rootPath, maxDepth)
  set texts to {}
  set visited to 0
  tell application "System Events"
    set frontier to {rootEl}
    set fpaths to {rootPath}
    set depth to 0
    repeat while (count of frontier) > 0 and depth < maxDepth and visited < 9000
      set nextFrontier to {}
      set nextPaths to {}
      repeat with fi from 1 to count of frontier
        set el to item fi of frontier
        set p to item fi of fpaths
        try
          set kids to (UI elements of el) as list
          if (count of kids) > 0 then
            set rs to (role of every UI element of el) as list
            set vs to (value of every UI element of el) as list
            repeat with i from 1 to count of kids
              set visited to visited + 1
              set kp to p & "/" & i
              if (item i of rs as text) is "AXStaticText" then
                set v to ""
                try
                  set v to item i of vs as text
                end try
                if v is not "" and v is not "missing value" then set end of texts to (kp & (ASCII character 9) & v)
              end if
              set end of nextFrontier to item i of kids
              set end of nextPaths to kp
            end repeat
          end if
        end try
        if visited >= 9000 then exit repeat
      end repeat
      set frontier to nextFrontier
      set fpaths to nextPaths
      set depth to depth + 1
    end repeat
  end tell
  return texts
end collectTexts

set resultTexts to {}
set directOk to false
set directTarget to missing value
tell application "System Events"
  if not (exists process "__APP__") then error "__APP__ が起動していません"
  tell process "__APP__"
    set win to front window
    try
      set t to win
      repeat with idx in {1, 1, 1, 1, 1, 1, 1, 3, 5}
        set t to UI element (idx as integer) of t
      end repeat
      set hit to 0
      try
        set vs to (value of every UI element of t) as list
        repeat with v in vs
          try
            set s to v as text
            if s starts with "ユーザーメッセージ:" or s starts with "アシスタントメッセージ:" then set hit to hit + 1
          end try
        end repeat
      end try
      if hit >= 2 then
        set directOk to true
        set directTarget to t
      end if
    end try
  end tell
end tell
if directOk then
  set resultTexts to collectTexts(directTarget, "/1/1/1/1/1/1/1/3/5", 14)
else
  set resultTexts to collectTexts(win, "", 24)
end if
set AppleScript's text item delimiters to (ASCII character 30)
return resultTexts as text
"#.replace("__APP__", &app);
  let out = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
  if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
  let recs: Vec<(Vec<u32>, String)> = String::from_utf8_lossy(&out.stdout).trim_end_matches('\n')
    .split('\u{1e}')
    .filter_map(|rec| {
      let (path, value) = rec.split_once('\t')?;
      let segs: Vec<u32> = path.split('/').filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
      if segs.is_empty() || value.trim().is_empty() { None } else { Some((segs, value.to_string())) }
    })
    .collect();
  Ok(build_messages(&recs))
}

/// 集めた（経路, 文字）から会話のメッセージを組み立てる
fn build_messages(recs: &[(Vec<u32>, String)]) -> Vec<ChatMsg> {
  use std::collections::BTreeMap;
  // 会話リストの候補を集める。目印は2種類：接頭辞つきメッセージの親と、
  // バラバラなユーザ発言の先頭断片「自分:」の2つ上の要素（＝リスト）。
  // 生まれたばかりの短い会話では接頭辞つきが1つも無いことがあるため、接頭辞の数では決めない。
  // 候補のうち、直接の子（メッセージ）がいちばん多いものを会話リストとする
  let mut candidates: Vec<Vec<u32>> = vec![];
  for (p, v) in recs {
    if v.starts_with("ユーザーメッセージ:") || v.starts_with("アシスタントメッセージ:") {
      if let Some((_, parent)) = p.split_last() { candidates.push(parent.to_vec()); }
    }
    if v.trim() == "自分:" && p.len() >= 2 { candidates.push(p[..p.len() - 2].to_vec()); }
  }
  let mut best: Option<(Vec<u32>, usize)> = None;
  for lp in candidates {
    let mut children = std::collections::BTreeSet::new();
    for (p, _) in recs { if p.len() > lp.len() && p[..lp.len()] == lp[..] { children.insert(p[lp.len()]); } }
    let n = children.len();
    if n >= 2 && best.as_ref().map_or(true, |(_, bn)| n > *bn) { best = Some((lp, n)); }
  }
  let list_parent = best.map(|(p, _)| p);
  let Some(lp) = list_parent else {
    // 会話リストが特定できないときは、接頭辞つきだけを拾う（従来の動き）
    let mut out = vec![];
    for (_, v) in recs {
      if let Some(b) = v.strip_prefix("アシスタントメッセージ:") { push_msg(&mut out, "assistant", b.trim()); }
      else if let Some(b) = v.strip_prefix("ユーザーメッセージ:") { push_msg(&mut out, "user", b.trim()); }
    }
    return out;
  };
  // リストの直接の子（＝1メッセージ）ごとに集める
  let mut by_child: BTreeMap<u32, Vec<&(Vec<u32>, String)>> = BTreeMap::new();
  for r in recs {
    if r.0.len() > lp.len() && r.0[..lp.len()] == lp[..] { by_child.entry(r.0[lp.len()]).or_default().push(r); }
  }
  let mut out: Vec<ChatMsg> = vec![];
  for (_, mut items) in by_child {
    // その子自体が接頭辞つきの値を持っていれば、それが全文（フラットな姿）
    let flat = items.iter().find(|(p, _)| p.len() == lp.len() + 1).map(|(_, v)| v.clone());
    if let Some(v) = &flat {
      if let Some(b) = v.strip_prefix("アシスタントメッセージ:") { push_msg(&mut out, "assistant", b.trim()); continue; }
      if let Some(b) = v.strip_prefix("ユーザーメッセージ:") { push_msg(&mut out, "user", b.trim()); continue; }
    }
    // バラバラな姿：経路の辞書順（＝文書順）に断片を並べてつなぐ
    items.sort_by(|a, b| a.0.cmp(&b.0));
    let frags: Vec<&str> = items.iter().map(|(_, v)| v.trim()).filter(|s| !s.is_empty()).collect();
    if frags.is_empty() { continue; }
    // ユーザーの発言は先頭の断片が「自分:」。それ以外はアシスタントの返事とみなす
    let (role, frags) = if frags[0] == "自分:" { ("user", &frags[1..]) } else { ("assistant", &frags[..]) };
    if frags.is_empty() { continue; }
    let mut body = String::new();
    for f in frags {
      if body.is_empty() { body.push_str(f); continue; }
      // 句読点・閉じ括弧で始まる断片や、開き括弧・空白で終わる本文は、改行せずにつなぐ（コード片の分割対策）
      let starts_punct = f.chars().next().map(|c| "。、）」』！？：；,.・".contains(c)).unwrap_or(false);
      let prev_open = body.ends_with(|c: char| c.is_whitespace() || "（「『".contains(c));
      if starts_punct || prev_open { body.push_str(f); } else { body.push('\n'); body.push_str(f); }
    }
    let body = body.trim().to_string();
    if body.is_empty() || is_time_only(&body) { continue; } // 時刻だけの要素はメッセージではない
    push_msg(&mut out, role, &body);
  }
  out
}

fn push_msg(out: &mut Vec<ChatMsg>, role: &str, text: &str) {
  if text.is_empty() { return; }
  if let Some(last) = out.last() { if last.role == role && last.text == text { return; } } // 連続する重複は1つに
  out.push(ChatMsg { role: role.to_string(), text: text.to_string() });
}

fn is_time_only(s: &str) -> bool {
  let s = s.trim();
  s.len() <= 5 && s.matches(':').count() == 1 && s.chars().all(|c| c.is_ascii_digit() || c == ':')
}

/// ウェブ版フックで届く返事（ブラウザ側スクリプト → この受け口 → 画面へのイベント）
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct HookReply { text: String, role: Option<String> }

/// ローカルの受け口（127.0.0.1:17654）を開き、POST /reply で届いた返事を画面へ渡す。
/// ブラウザ（https のページ）からローカルへ送るため、CORS と Private Network Access のヘッダを返す
fn start_hook_server(app: tauri::AppHandle) {
  use std::io::{Read, Write};
  use tauri::Emitter;
  std::thread::spawn(move || {
    let listener = match std::net::TcpListener::bind("127.0.0.1:17654") {
      Ok(l) => l,
      Err(e) => { println!("[muse-stage] フック受け口を開けません: {e}"); return; }
    };
    println!("[muse-stage] フック受け口: http://127.0.0.1:17654/reply");
    for stream in listener.incoming() {
      let Ok(mut s) = stream else { continue };
      let app = app.clone();
      std::thread::spawn(move || {
        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
        let mut buf: Vec<u8> = vec![];
        let mut chunk = [0u8; 8192];
        let header_end = loop {
          match s.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => { buf.extend_from_slice(&chunk[..n]); if let Some(pos) = find_sub(&buf, b"\r\n\r\n") { break pos + 4; } if buf.len() > 262144 { return; } }
            Err(_) => return,
          }
        };
        let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let method = head.split_whitespace().next().unwrap_or("").to_string();
        let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n";
        if method == "OPTIONS" {
          let _ = s.write_all(format!("HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\n\r\n").as_bytes());
          return;
        }
        if method != "POST" { let _ = s.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"); return; }
        let want: usize = head.lines().find_map(|l| {
          let l = l.to_ascii_lowercase();
          l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())
        }).unwrap_or(0);
        while buf.len() - header_end < want && buf.len() <= 262144 {
          match s.read(&mut chunk) { Ok(0) => break, Ok(n) => buf.extend_from_slice(&chunk[..n]), Err(_) => break }
        }
        let end = (header_end + want).min(buf.len());
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[header_end..end]) {
          let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
          if !text.is_empty() {
            println!("[muse-stage] フックで返事が届きました（{} 文字）", text.chars().count());
            let role = v.get("role").and_then(|r| r.as_str()).map(|s| s.to_string());
            let _ = app.emit("hooked-reply", HookReply { text, role });
          }
        }
        let _ = s.write_all(format!("HTTP/1.1 200 OK\r\n{cors}Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}").as_bytes());
      });
    }
  });
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> { hay.windows(needle.len()).position(|w| w == needle) }

/// 動作確認の記録を、起動したターミナルに出す
#[tauri::command]
fn report(msg: String) { println!("[muse-stage] {msg}"); }

/// 自己確認モード（MUSE_SELFTEST=1 で起動したとき）
#[tauri::command]
fn selftest() -> bool { std::env::var("MUSE_SELFTEST").map(|v| v == "1").unwrap_or(false) }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Speaker(Mutex::new(None)))
    .setup(|app| { start_hook_server(app.handle().clone()); Ok(()) })
    .invoke_handler(tauri::generate_handler![speak_say, stop_say, ja_voices, report, selftest, read_muse])
    .run(tauri::generate_context!())
    .expect("muse-stage を起動できませんでした");
}
