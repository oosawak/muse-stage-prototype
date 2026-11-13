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

/// 第2段の実験：Mac版ミューズアプリ（Muse.app）の窓に出ている文字を、アクセシビリティ経由で読む。
/// System Events に「窓の中の文字（static text）の値」を聞く。muse-stage にアクセシビリティの許可が要る。
/// 返り値：読めた文字の一覧（画面の上から順）。許可がないなどで読めないときはエラーの文を返す
#[tauri::command]
async fn read_muse(app: String) -> Result<Vec<String>, String> {
  let app = if app.is_empty() { "Muse".to_string() } else { app };
  let script = format!(r#"
tell application "System Events"
  if not (exists process "{app}") then error "{app} が起動していません"
  tell process "{app}"
    set out to {{}}
    repeat with el in (entire contents of front window)
      try
        if role of el is "AXStaticText" then
          set v to value of el
          if v is not missing value and v is not "" then set end of out to v
        end if
      end try
    end repeat
  end tell
end tell
set AppleScript's text item delimiters to (ASCII character 30)
return out as text
"#);
  let out = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
  if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
  Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').split('\u{1e}').map(|s| s.to_string()).filter(|s| !s.trim().is_empty()).collect())
}

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
    .invoke_handler(tauri::generate_handler![speak_say, stop_say, ja_voices, report, selftest, read_muse])
    .run(tauri::generate_context!())
    .expect("muse-stage を起動できませんでした");
}
