// Release builds are GUI-only (no console window); debug builds keep the console for panics.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod app;
mod index;
mod indexer;
mod mft;
mod preview;
mod search;
mod util;
mod walk;

use eframe::egui;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("FileSearchCraft")
            .with_inner_size([1200.0, 760.0])
            .with_min_inner_size([640.0, 400.0]),
        persist_window: true,
        ..Default::default()
    };
    eframe::run_native(
        "FileSearchCraft",
        options,
        Box::new(|cc| {
            egui_extras::install_image_loaders(&cc.egui_ctx);
            Ok(Box::new(app::FileSearchCraftApp::new(cc)))
        }),
    )
}
