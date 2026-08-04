import SwiftUI

struct ProfileView: View {
    let participant: Participant
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    ZStack(alignment: .bottom) {
                        LuxoraTheme.brandGradient
                            .frame(height: 190)
                            .overlay(LuxoraTheme.ambientGradient)
                        AvatarView(participant: participant, size: 106)
                            .offset(y: 40)
                    }
                    .padding(.bottom, 38)

                    VStack(spacing: 5) {
                        Text(participant.displayName)
                            .font(.title.bold())
                        Text("@\(participant.username)")
                            .foregroundStyle(.secondary)
                        Text(participant.status)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 16) {
                        Label("luxora.app/\(participant.username)", systemImage: "link")
                        Label(LuxoraL10n.text("legacy.joined"), systemImage: "calendar")
                        Label(LuxoraL10n.text("legacy.mutual_groups"), systemImage: "person.2")
                        Label(LuxoraL10n.text("legacy.manage_devices"), systemImage: "laptopcomputer.and.iphone")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(18)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .padding(.horizontal, 20)
                }
            }
            .navigationTitle(LuxoraL10n.text("legacy.profile"))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(LuxoraL10n.text("common.done")) { dismiss() }
                }
            }
        }
        .frame(minWidth: 430, minHeight: 560)
    }
}
