// The settings window. It opens when you launch the app (from Applications, Launchpad or Spotlight),
// including when he is already running, and from the menu bar icon. Kept small: a header with the everyday
// controls, then three short tabs.

import SwiftUI
import AppKit
import ServiceManagement

/// Lets the window redraw whenever the app's state changes.
final class UIModel: ObservableObject {
    func refresh() { objectWillChange.send() }
}

struct SettingsView: View {
    @ObservedObject var model: UIModel
    @State private var tab = Int(ProcessInfo.processInfo.environment["CHELIK_TAB"] ?? "") ?? 0 // (developer hook)
    private var app: App { App.shared }
    private var s: Settings { App.shared.settings }

    private func bind<T>(_ get: @escaping () -> T, _ set: @escaping (T) -> Void) -> Binding<T> {
        Binding(get: get, set: { set($0); App.shared.apply(); model.refresh() })
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Picker("", selection: $tab) {
                Text("Акко").tag(0); Text("Характер").tag(3); Text("Мир").tag(1); Text("Система").tag(2)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 16)
            .padding(.top, 12)
            Form {
                switch tab {
                case 0: looks
                case 1: world
                case 3: character; wellbeing
                default: system
                }
            }
            .formStyle(.grouped)
            .scrollDisabled(true)
            .frame(height: tab == 3 ? 565 : tab == 0 ? 345 : 300)
        }
        .frame(width: 380)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.refresh() }
    }

    /// Who he is, what he is doing, and the three things you reach for most.
    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text("Акко").font(.headline)
                Text(app.statusText).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Menu {
                Button("Случайный") { app.play(nil) }
                Divider()
                ForEach(app.actNames, id: \.0) { n in Button(n.1) { app.play(n.0) } }
            } label: { Image(systemName: "sparkles") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(!app.running)
            Button { s.paused.toggle(); app.apply(); model.refresh() } label: {
                Image(systemName: s.paused ? "play.fill" : "pause.fill").frame(width: 16)
            }
            .disabled(!s.visible)
            Toggle("", isOn: bind({ s.visible }, { s.visible = $0 }))
                .toggleStyle(.switch)
                .labelsHidden()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder private var looks: some View {
        Picker("Размер", selection: bind({ s.size }, { s.size = $0 })) {
            Text("S").tag(32); Text("M").tag(44); Text("L").tag(60); Text("XL").tag(84)
        }
        .pickerStyle(.segmented)
        Picker("Язык фраз", selection: bind({ s.lang }, { s.lang = $0 })) {
            Text("English").tag("en"); Text("Русский").tag("ru")
        }
        .pickerStyle(.segmented)
        Picker("Экономия", selection: bind({ s.power }, { s.power = $0 })) {
            Text("Авто").tag("auto"); Text("Всегда").tag("on"); Text("Выкл").tag("off")
        }
        .pickerStyle(.segmented)
        Toggle("Прятаться при видео и звонках", isOn: bind({ s.hideVideo }, { s.hideVideo = $0 }))
        Toggle("Прятаться в полноэкранных играх и презентациях", isOn: bind({ s.hideFullScreen }, { s.hideFullScreen = $0 }))
        Toggle("Прятаться при записи и показе экрана", isOn: bind({ s.hideCapture }, { s.hideCapture = $0 }))
        Text("Если выключено, во время записи экрана и демонстрации в Zoom он остаётся на виду.")
            .font(.caption).foregroundStyle(.secondary)
    }

    /// Who he is: how lively and how chatty, and his habits.
    @ViewBuilder private var character: some View {
        Picker("Активность", selection: bind({ s.activity }, { s.activity = $0 })) {
            Text("Спокойный").tag(0); Text("Обычный").tag(1); Text("Энергичный").tag(2)
        }
        .pickerStyle(.segmented)
        Picker("Болтливость", selection: bind({ s.chatty }, { s.chatty = $0 })) {
            Text("Молчун").tag(0); Text("Обычно").tag(1); Text("Болтун").tag(2)
        }
        .pickerStyle(.segmented)
        Toggle("Бегать за курсором и звать поиграть", isOn: bind({ s.follow }, { s.follow = $0 }))
        Toggle("Напоминать о перерыве", isOn: bind({ s.breaks }, { s.breaks = $0 }))
        Toggle("Засыпать ночью", isOn: bind({ s.nightSleep }, { s.nightSleep = $0 }))
    }

    /// How he feels, as three bars, and what you can do about it.
    @ViewBuilder private var wellbeing: some View {
        Section {
            meter("Энергия", app.energy, app.energyText, .yellow)
            meter("Настроение", app.mood, app.moodText, .pink)
            meter("Сытость", app.full, app.fullText, .orange)
            HStack {
                Button { app.feed() } label: { Label("Бросить еду", systemImage: "carrot.fill") }
                Button { app.play("coffee") } label: { Label("Дать кофе", systemImage: "cup.and.saucer.fill") }
                Spacer()
            }
            .disabled(!app.running)
            Text("Трюки тратят энергию, сон и кофе её возвращают. Еду можно бросать сколько угодно: он ест, пока не наестся, а что не успел съесть — через 5 секунд исчезнет. Сытость проходит за несколько часов. Внимание и еда поднимают настроение, скука его портит.")
                .font(.caption).foregroundStyle(.secondary)
        } header: { Text("Самочувствие") }
    }

    private func meter(_ title: String, _ value: Double, _ word: String, _ tint: Color) -> some View {
        LabeledContent(title) {
            HStack(spacing: 10) {
                ProgressView(value: max(0, min(1, value))).tint(tint).frame(width: 84)
                Text(word).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
            }
        }
    }

    @ViewBuilder private var world: some View {
        Toggle("Лазить по окнам и доку", isOn: bind({ s.climb }, { s.climb = $0 }))
        Toggle("Реагировать на программы и события", isOn: bind({ s.senses }, { s.senses = $0 }))
        LabeledContent("Видеть края, док и иконки") {
            if Sight.allowed {
                Label("видит", systemImage: "eye.fill").foregroundStyle(.green)
            } else {
                Button("Разрешить…") { app.askScreen() }
            }
        }
        .disabled(!s.climb)
        Text("С «Записью экрана» он сам видит, где у окон края, какой длины док и где лежат иконки. Он смотрит только на прозрачность, картинки нигде не сохраняются. После разрешения перезапусти его.")
            .font(.caption).foregroundStyle(.secondary)
    }

    @ViewBuilder private var system: some View {
        Toggle("Запускать при входе в систему", isOn: Binding(
            get: { SMAppService.mainApp.status == .enabled },
            set: { on in app.setLaunchAtLogin(on); model.refresh() }))
        Toggle("Значок в строке меню", isOn: bind({ s.menuIcon }, { s.menuIcon = $0 }))
        LabeledContent("Показать / спрятать", value: "⌘⌥⇧M")
        HStack {
            Text("Настройки — запусти приложение ещё раз").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button("Выйти") { NSApp.terminate(nil) }
        }
    }
}

extension App {
    /// Turns launch at login on or off. When macOS wants the user to approve it (or refuses), opens
    /// System Settings → Login Items instead of failing silently with the switch flipping back.
    func setLaunchAtLogin(_ on: Bool) {
        let login = SMAppService.mainApp
        do { if on { try login.register() } else { try login.unregister() } }
        catch { NSLog("login item: \(error)") }
        if on, login.status != .enabled { SMAppService.openSystemSettingsLoginItems() }
    }

    func showSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(model: uiModel)))
            w.title = "Акко"
            w.styleMask = [.titled, .closable]
            w.isReleasedWhenClosed = false
            w.center()
            settingsWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
        // Developer hook: with CHELIK_SNAP=/folder, save a picture of this window's content (no screen access needed).
        if let dir = ProcessInfo.processInfo.environment["CHELIK_SNAP"], let v = settingsWindow?.contentView {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                v.cacheDisplay(in: v.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("settings.png"))
            }
        }
    }
}
