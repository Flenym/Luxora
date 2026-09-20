#if os(iOS)
import SwiftUI

struct PhoneServerDevicesSettingsView: View {
    let store: DeviceSessionsStore?
    let gate: FeatureGate
    let signOut: () -> Void

    var body: some View {
        Group {
            if let store {
                LoadedPhoneDevicesSettingsView(store: store, gate: gate, signOut: signOut)
            } else {
                unavailableFixtureContent
            }
        }
        .navigationTitle(LuxoraL10n.text("settings.devices"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("you-devices-screen")
    }

    private var unavailableFixtureContent: some View {
        List {
            Section("Текущая доступность") {
                Label(gate.detail, systemImage: gate.symbol)
                    .foregroundStyle(.secondary)
            }
            Section("Этот сеанс") {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Этот iPhone")
                        Text("Серверный список недоступен в локальном дизайн-сценарии")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "iphone")
                }
                Button("Завершить текущий сеанс", role: .destructive, action: signOut)
                    .accessibilityIdentifier("devices-revoke-current")
            }
        }
    }
}

private struct LoadedPhoneDevicesSettingsView: View {
    @Bindable var store: DeviceSessionsStore
    let gate: FeatureGate
    let signOut: () -> Void

    @State private var pendingRevocation: DeviceSession?
    @State private var confirmsCurrentSignOut = false
    @State private var confirmsTerminateOthers = false

    var body: some View {
        List {
            Section("Сервер Luxora") {
                HStack(spacing: 12) {
                    Image(systemName: gate.symbol)
                        .foregroundStyle(LuxoraTheme.iris)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Активные сеансы")
                        Text(gate.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(gate.state.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(gate.state == .available ? LuxoraTheme.success : .secondary)
                }
            }

            sessionContent
        }
        .task {
            guard gate.state != .unavailable, store.loadState == .idle else { return }
            await store.refresh()
        }
        .refreshable {
            guard gate.state != .unavailable else { return }
            await store.refresh(force: true)
        }
        .confirmationDialog(
            "Завершить сеанс на устройстве «\(pendingRevocation?.deviceName ?? "")»?",
            isPresented: Binding(
                get: { pendingRevocation != nil },
                set: { if !$0 { pendingRevocation = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Завершить сеанс", role: .destructive) {
                guard let sessionID = pendingRevocation?.id else { return }
                pendingRevocation = nil
                Task { await store.revoke(sessionID) }
            }
            Button("Отмена", role: .cancel) { pendingRevocation = nil }
        } message: {
            Text("Устройство потеряет доступ к новым сообщениям и должно будет войти снова.")
        }
        .confirmationDialog(
            "Завершить текущий сеанс?",
            isPresented: $confirmsCurrentSignOut,
            titleVisibility: .visible
        ) {
            Button("Выйти на этом iPhone", role: .destructive, action: signOut)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Локальные ключи входа будут удалены после запроса к серверу.")
        }
        .confirmationDialog(
            "Завершить все другие сеансы?",
            isPresented: $confirmsTerminateOthers,
            titleVisibility: .visible
        ) {
            Button("Завершить другие сеансы", role: .destructive) {
                confirmsTerminateOthers = false
                Task { await store.terminateOtherSessions() }
            }
            Button("Отмена", role: .cancel) { confirmsTerminateOthers = false }
        } message: {
            Text("Другие устройства потеряют доступ и должны будут войти снова. Текущий сеанс сохранится.")
        }
    }

    @ViewBuilder
    private var sessionContent: some View {
        if store.sessions.isEmpty, store.loadState == .loading {
            Section {
                HStack {
                    Spacer()
                    ProgressView("Загрузка устройств…")
                    Spacer()
                }
                .accessibilityIdentifier("devices-loading")
            }
        } else if store.sessions.isEmpty, case let .failed(message) = store.loadState {
            Section {
                ContentUnavailableView(
                    "Не удалось загрузить устройства",
                    systemImage: "wifi.exclamationmark",
                    description: Text(message)
                )
                Button("Повторить") { Task { await store.refresh(force: true) } }
                    .accessibilityIdentifier("devices-load-retry")
            }
        } else if store.sessions.isEmpty, store.loadState == .loaded {
            Section {
                ContentUnavailableView(
                    "Активных сеансов нет",
                    systemImage: "laptopcomputer.slash",
                    description: Text("Сервер не вернул ни одного активного устройства.")
                )
            }
        } else {
            if let current = store.sessions.first(where: \.isCurrent) {
                Section("Это устройство") {
                    sessionRow(current)
                    Button("Завершить текущий сеанс", role: .destructive) {
                        confirmsCurrentSignOut = true
                    }
                    .accessibilityIdentifier("devices-revoke-current")
                }
            }

            let others = store.sessions.filter { !$0.isCurrent }
            if !others.isEmpty {
                Section("Другие устройства") {
                    ForEach(others) { session in
                        sessionRow(session)
                    }
                    Button("Завершить другие сеансы", role: .destructive) {
                        confirmsTerminateOthers = true
                    }
                    .disabled(store.terminateOthersState == .loading)
                    .accessibilityIdentifier("devices-terminate-others")
                    if case let .failed(message) = store.terminateOthersState {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }

            if case let .failed(message) = store.loadState {
                Section("Обновление списка") {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Button("Повторить загрузку") { Task { await store.refresh(force: true) } }
                        .accessibilityIdentifier("devices-load-retry")
                }
            }
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: DeviceSession) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: symbol(for: session.deviceName))
                    .font(.title3)
                    .foregroundStyle(session.isCurrent ? LuxoraTheme.success : LuxoraTheme.iris)
                    .frame(width: 34, height: 34)
                    .background(Color.secondary.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 3) {
                    Text(session.deviceName)
                        .font(.body.weight(.medium))
                    Text(session.isCurrent ? "Текущее устройство" : "Последняя активность")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(session.lastSeenAt, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if session.isCurrent {
                    Text("Текущий")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(LuxoraTheme.success)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(LuxoraTheme.success.opacity(0.12), in: Capsule())
                        .accessibilityIdentifier("device-session-current-marker")
                }
            }

            Text("Действует до \(session.expiresAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if !session.isCurrent {
                revocationControl(for: session)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func revocationControl(for session: DeviceSession) -> some View {
        switch store.revocationStates[session.id] ?? .idle {
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Завершаем сеанс на сервере…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("device-session-revoking-\(session.id.apiPathComponent)")
        case let .failed(message):
            VStack(alignment: .leading, spacing: 8) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("device-session-revoke-error-\(session.id.apiPathComponent)")
                Button("Повторить завершение", role: .destructive) {
                    pendingRevocation = session
                }
                .accessibilityIdentifier("device-session-revoke-retry-\(session.id.apiPathComponent)")
            }
        case .idle, .loaded:
            Button("Завершить сеанс", role: .destructive) {
                pendingRevocation = session
            }
            .accessibilityIdentifier("device-session-revoke-\(session.id.apiPathComponent)")
        }
    }

    private func symbol(for deviceName: String) -> String {
        let normalized = deviceName.lowercased()
        if normalized.contains("iphone") { return "iphone" }
        if normalized.contains("ipad") { return "ipad" }
        if normalized.contains("mac") { return "laptopcomputer" }
        if normalized.contains("windows") || normalized.contains("pc") { return "desktopcomputer" }
        return "display"
    }
}
#endif
