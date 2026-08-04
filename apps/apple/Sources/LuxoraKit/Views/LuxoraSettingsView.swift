import SwiftUI

public struct LuxoraSettingsView: View {
    @Bindable private var store: MessengerStore

    public init(store: MessengerStore) {
        self.store = store
    }

    public var body: some View {
        Form {
            Section(LuxoraL10n.text("appearance.title")) {
                Picker(LuxoraL10n.text("appearance.theme"), selection: $store.preferredAppearance) {
                    Text(LuxoraL10n.text("appearance.system")).tag("system")
                    Text(LuxoraL10n.text("appearance.light")).tag("light")
                    Text(LuxoraL10n.text("appearance.dark")).tag("dark")
                }
                .pickerStyle(.segmented)

                Toggle(LuxoraL10n.text("appearance.reduce_motion"), isOn: $store.reduceMotion)
            }

            Section(LuxoraL10n.text("privacy.title")) {
                LabeledContent(
                    LuxoraL10n.text("privacy.private_spaces"),
                    value: LuxoraL10n.text("privacy.private_spaces_value")
                )
                LabeledContent(
                    LuxoraL10n.text("privacy.public_spaces"),
                    value: LuxoraL10n.text("privacy.public_spaces_value")
                )
                Button(LuxoraL10n.text("privacy.linked_devices")) {}
                    .disabled(true)
                Button(LuxoraL10n.text("privacy.passkeys_2fa")) {}
                    .disabled(true)
            }

            Section(LuxoraL10n.text("data.title")) {
                Toggle(LuxoraL10n.text("data.auto_media"), isOn: .constant(true))
                    .disabled(true)
                Toggle(LuxoraL10n.text("data.low_data_calls"), isOn: .constant(false))
                    .disabled(true)
            }

            Section {
                Text(LuxoraL10n.text("security.development_disclaimer"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(LuxoraL10n.text("settings.about")) {
                LabeledContent(LuxoraL10n.text("common.version"), value: "Beta-0.1")
                LabeledContent(LuxoraL10n.text("common.developer_owner"), value: "Flenym")
            }
        }
        .formStyle(.grouped)
        .navigationTitle(LuxoraL10n.text("settings.title"))
        .padding()
    }
}
