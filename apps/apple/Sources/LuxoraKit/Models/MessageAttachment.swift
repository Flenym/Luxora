import Foundation

/// A server-confirmed attachment bound to a message.
public struct MessageAttachment: Identifiable, Hashable, Codable, Sendable {
    public let id: UUID
    public let kind: String
    public let fileName: String
    public let mimeType: String
    public let sizeBytes: Int
    public let downloadPath: String
    public let imageWidth: Int?
    public let imageHeight: Int?

    public init(
        id: UUID,
        kind: String,
        fileName: String,
        mimeType: String,
        sizeBytes: Int,
        downloadPath: String,
        imageWidth: Int? = nil,
        imageHeight: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.fileName = fileName
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.downloadPath = downloadPath
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
    }

    public var isImage: Bool { kind == "image" }

    public var formattedSize: String {
        ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file)
    }
}

/// Media picked in the composer that still has to be uploaded.
public struct PendingMediaAttachment: Identifiable, Sendable {
    public let id: UUID
    public let kind: String
    public let fileName: String
    public let mimeType: String
    public let data: Data
    public let imageWidth: Int?
    public let imageHeight: Int?

    public init(
        id: UUID = UUID(),
        kind: String,
        fileName: String,
        mimeType: String,
        data: Data,
        imageWidth: Int? = nil,
        imageHeight: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.fileName = fileName
        self.mimeType = mimeType
        self.data = data
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
    }
}
