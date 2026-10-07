use std::sync::Mutex;
use tauri::{
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
struct SessionToken(Mutex<Option<String>>);

/// Main's end of the quick-send relay.
#[derive(Default)]
struct QuickSendRelay(Mutex<Option<Channel<serde_json::Value>>>);

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Cette fenêtre n’a pas accès aux identifiants.".into())
    }
}

fn require_quick_send(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "quick-send" {
        Ok(())
    } else {
        Err("Cette fenêtre ne peut pas envoyer.".into())
    }
}

#[tauri::command]
fn quick_send_listen(
    window: WebviewWindow,
    channel: Channel<serde_json::Value>,
    relay: State<'_, QuickSendRelay>,
) -> Result<(), String> {
    require_main(&window)?;
    *relay.0.lock().map_err(|_| "Relais indisponible.")? = Some(channel);
    Ok(())
}

// Events carry no sender, so any webview could forge one. A channel only reaches main, and only quick-send may feed it.
#[tauri::command]
fn quick_send(
    window: WebviewWindow,
    request: serde_json::Value,
    relay: State<'_, QuickSendRelay>,
) -> Result<(), String> {
    require_quick_send(&window)?;
    let relay = relay.0.lock().map_err(|_| "Relais indisponible.")?;
    relay
        .as_ref()
        .ok_or("DropMeme ne répond pas.")?
        .send(request)
        .map_err(|_| "DropMeme ne répond pas.".into())
}

// WebView2 deadlocks when a webview is built from a synchronous IPC command.
#[tauri::command]
async fn create_placement(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    if window
        .app_handle()
        .get_webview_window("placement")
        .is_some()
    {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        window.app_handle(),
        "placement",
        WebviewUrl::App("placement.html".into()),
    )
    .title("DropMeme · Placer la zone")
    .inner_size(480.0, 320.0)
    .min_inner_size(160.0, 120.0)
    .max_inner_size(8192.0, 4320.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .visible(false);
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args("--autoplay-policy=no-user-gesture-required");
    builder
        .build()
        .map(|_| ())
        .map_err(|_| "Création du cadre de placement impossible.".into())
}

#[tauri::command]
async fn create_overlay(window: WebviewWindow, label: Option<String>) -> Result<(), String> {
    require_main(&window)?;
    let label = label.unwrap_or_else(|| "overlay".into());
    if label != "overlay"
        && !label
            .strip_prefix("overlay-")
            .and_then(|index| index.parse::<u8>().ok())
            .is_some_and(|index| (1..8).contains(&index))
    {
        return Err("Superposition invalide.".into());
    }
    if window.app_handle().get_webview_window(&label).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        window.app_handle(),
        &label,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("DropMeme · Média")
    .inner_size(480.0, 320.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .focused(false)
    .focusable(false)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false);
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args("--autoplay-policy=no-user-gesture-required");
    builder
        .build()
        .map(|_| ())
        .map_err(|_| "Création de la superposition impossible.".into())
}

#[cfg(target_os = "windows")]
fn credential(window: &WebviewWindow) -> Result<keyring::Entry, String> {
    // Keyed by identifier so the dev build never touches the installed app's token.
    keyring::Entry::new(&window.config().identifier, "device")
        .map_err(|_| "Le gestionnaire d’identifiants Windows est inaccessible.".into())
}

#[tauri::command]
fn load_token(window: WebviewWindow) -> Result<Option<String>, String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    {
        match credential(&window)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Lecture sécurisée des identifiants impossible.".into()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        window
            .state::<SessionToken>()
            .0
            .lock()
            .map(|token| token.clone())
            .map_err(|_| "Lecture de la session impossible.".into())
    }
}

#[tauri::command]
fn save_token(window: WebviewWindow, token: String) -> Result<(), String> {
    require_main(&window)?;
    if token.len() < 32 || token.len() > 128 || !token.is_ascii() {
        return Err("Jeton invalide.".into());
    }
    #[cfg(target_os = "windows")]
    {
        credential(&window)?
            .set_password(&token)
            .map_err(|_| "Enregistrement sécurisé impossible.".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        *window
            .state::<SessionToken>()
            .0
            .lock()
            .map_err(|_| "Enregistrement de la session impossible.")? = Some(token);
        Ok(())
    }
}

#[tauri::command]
fn clear_token(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    #[cfg(target_os = "windows")]
    {
        match credential(&window)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Suppression sécurisée impossible.".into()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        *window
            .state::<SessionToken>()
            .0
            .lock()
            .map_err(|_| "Suppression de la session impossible.")? = None;
        Ok(())
    }
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, update: Option<&str>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Ouvrir DropMeme", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    if let Some(version) = update {
        let label = format!("Mettre à jour vers {version}");
        menu.prepend(&MenuItem::with_id(app, "update", label, true, None::<&str>)?)?;
    }
    Ok(menu)
}

#[tauri::command]
fn announce_update(window: WebviewWindow, version: String) -> Result<(), String> {
    require_main(&window)?;
    let valid = version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c));
    if version.is_empty() || version.len() > 32 || !valid {
        return Err("Version invalide.".into());
    }
    let app = window.app_handle();
    let tray = app.tray_by_id("main").ok_or("Zone de notification indisponible.")?;
    tray_menu(app, Some(&version))
        .and_then(|menu| tray.set_menu(Some(menu)))
        .map_err(|_| "Mise à jour du menu impossible.".into())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "windows"))]
    let builder = builder.manage(SessionToken::default());
    builder
        .manage(QuickSendRelay::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_token,
            save_token,
            clear_token,
            create_overlay,
            create_placement,
            announce_update,
            quick_send_listen,
            quick_send
        ])
        .setup(|app| {
            let menu = tray_menu(app.handle(), None)?;
            let name = app.package_info().name.clone();
            if let Some(main) = app.get_webview_window("main") {
                main.set_title(&name)?;
            }
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip(&name)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "update" => {
                        show_main(app);
                        let _ = app.emit_to("main", "tray-update", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // Both stay alive hidden: main relays quick-send requests, quick-send must open instantly.
            ("main" | "quick-send", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            ("quick-send", WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("Impossible de démarrer DropMeme");
}
