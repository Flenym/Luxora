import Foundation

struct PhoneProfileSharePayload: Equatable, Sendable {
    let displayName: String
    let username: String

    init(participant: Participant) {
        displayName = participant.displayName
        username = participant.username
    }

    var shareText: String {
        "\(displayName) в Luxora — @\(username)"
    }

    var qrText: String {
        [
            "Luxora Beta-0.1",
            "Имя: \(displayName)",
            "Username: @\(username)",
        ].joined(separator: "\n")
    }
}

struct PhoneFolderSummary: Equatable, Sendable {
    let folder: ConversationFolder
    let conversationCount: Int

    static func make(
        from conversations: [Conversation],
        folders: [ConversationFolder] = ConversationFolder.allCases
    ) -> [PhoneFolderSummary] {
        folders.map { folder in
            PhoneFolderSummary(
                folder: folder,
                conversationCount: conversations.lazy.filter { folder.includes($0) }.count
            )
        }
    }
}

struct PhoneLoadedMessageSearch: Sendable {
    static func results(in messages: [ChatMessage], query: String) -> [ChatMessage] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return messages.sorted { $0.sentAt > $1.sentAt } }

        return messages
            .filter {
                $0.text.localizedCaseInsensitiveContains(normalizedQuery)
                    || $0.author.displayName.localizedCaseInsensitiveContains(normalizedQuery)
                    || $0.author.username.localizedCaseInsensitiveContains(normalizedQuery)
            }
            .sorted { $0.sentAt > $1.sentAt }
    }
}
