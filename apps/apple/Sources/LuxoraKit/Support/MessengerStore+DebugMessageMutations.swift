#if DEBUG
import Foundation

@MainActor
extension MessengerStore {
    /// Deterministic server-shaped message actions for focused Xcode UI tests.
    /// Production never calls this path; Release builds do not compile it.
    func installDebugMessageMutationFixture() {
        guard let sender = remoteMessageSender,
              let loader = remoteMessageLoader
        else { return }

        let currentUser = currentUser
        let initialMessagesByID = Dictionary(
            uniqueKeysWithValues: messagesByConversation.values
                .flatMap { $0 }
                .map { ($0.id, $0) }
        )
        configureRemote(
            sender: sender,
            loader: loader,
            conversationsLoader: remoteConversationLoader,
            peopleSearcher: remotePeopleSearcher,
            directConversationCreator: remoteDirectConversationCreator,
            readMarker: remoteReadMarker,
            reactionSetter: remoteReactionSetter,
            messageSender: { conversationID, nonce, body, replyToID in
                RemoteMessageSnapshot(
                    message: ChatMessage(
                        id: UUID(),
                        clientID: nonce,
                        conversationID: conversationID,
                        author: currentUser,
                        text: body,
                        sentAt: .now,
                        delivery: .sent,
                        isOutgoing: true
                    ),
                    metadata: MessageRemoteMetadata(
                        revision: 0,
                        replyToMessageID: replyToID
                    )
                )
            },
            messageEditor: { messageID, body, expectedRevision in
                guard var message = initialMessagesByID[messageID] else {
                    throw DebugMessageMutationError.messageUnavailable
                }
                message.text = body
                message.editedAt = .now
                message.delivery = .sent
                return RemoteMessageSnapshot(
                    message: message,
                    metadata: MessageRemoteMetadata(revision: (expectedRevision ?? 0) + 1)
                )
            },
            messageDeleter: { messageID in
                guard var message = initialMessagesByID[messageID] else {
                    throw DebugMessageMutationError.messageUnavailable
                }
                message.text = "Сообщение удалено"
                message.reactions = []
                return RemoteMessageSnapshot(
                    message: message,
                    metadata: MessageRemoteMetadata(
                        revision: 1,
                        isDeleted: true
                    )
                )
            },
            messageForwarder: { messageID, targetConversationID, nonce in
                guard let source = initialMessagesByID[messageID] else {
                    throw DebugMessageMutationError.messageUnavailable
                }
                return RemoteMessageSnapshot(
                    message: ChatMessage(
                        id: UUID(),
                        clientID: nonce,
                        conversationID: targetConversationID,
                        author: currentUser,
                        text: source.text,
                        sentAt: .now,
                        delivery: .sent,
                        isOutgoing: true
                    ),
                    metadata: MessageRemoteMetadata(
                        revision: 0,
                        forwardedFrom: MessageForwardProvenance(
                            senderDisplayName: source.author.displayName,
                            originalCreatedAt: source.sentAt
                        )
                    )
                )
            },
            messagePinSetter: { _, _, active in active }
        )
    }
}

private enum DebugMessageMutationError: LocalizedError, Sendable {
    case messageUnavailable

    var errorDescription: String? {
        "Сообщение отсутствует в DEBUG-сценарии."
    }
}
#endif
