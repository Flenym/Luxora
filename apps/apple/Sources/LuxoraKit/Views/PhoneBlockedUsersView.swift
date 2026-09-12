#if os(iOS)
import SwiftUI

struct PhoneBlockedUsersView: View {
    @Bindable var store: MessengerStore

    var body: some View {
        Group {
            switch store.blockedUsersState {
            case .idle, .loading where store.blockedUsers.isEmpty:
                ProgressView("Загружаем…")
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 40)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Не удалось загрузить", systemImage: "person.crop.circle.badge.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Повторить") {
                        Task { await store.loadBlockedUsers(force: true) }
                    }
                    .buttonStyle(.borderedProminent)
                }
            case _ where store.blockedUsers.isEmpty:
                ContentUnavailableView(
                    "Нет заблокированных",
                    systemImage: "person.crop.circle.badge.checkmark",
                    description: Text("Заблокированные пользователи появятся здесь. Блокировка скрывает ваши сообщения, звонки и профиль от них.")
                )
            default:
                List {
                    ForEach(store.blockedUsers) { user in
                        HStack(spacing: 12) {
                            AvatarView(participant: user, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName).font(.callout.weight(.semibold)).lineLimit(1)
                                Text("@\(user.username)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Button("Разблокировать", role: .destructive) {
                                Task { await store.unblockUser(id: user.id) }
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                            .tint(.red)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                Task { await store.unblockUser(id: user.id) }
                            } label: {
                                Label("Разблокировать", systemImage: "person.crop.circle.badge.checkmark")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Заблокированные")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("blocked-users-screen")
        .task { await store.loadBlockedUsers() }
        .refreshable { await store.loadBlockedUsers(force: true) }
    }
}
#endif
