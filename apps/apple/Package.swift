// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "LuxoraApple",
    defaultLocalization: "ru",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "LuxoraKit", targets: ["LuxoraKit"]),
        .library(name: "LuxoraDesignFixtures", targets: ["LuxoraDesignFixtures"]),
        .executable(name: "LuxoraMac", targets: ["LuxoraMac"]),
    ],
    dependencies: [
        // LiveKit client SDK: the iPhone call media plane (voice). Pinned to a
        // minor range so API breaks are reviewed deliberately.
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.17.0"),
    ],
    targets: [
        .target(
            name: "LuxoraKit",
            dependencies: [
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ],
            resources: [.process("Resources")]
        ),
        .target(
            name: "LuxoraDesignFixtures",
            dependencies: ["LuxoraKit"]
        ),
        .executableTarget(
            name: "LuxoraMac",
            dependencies: ["LuxoraKit"],
            path: "Apps/macOS"
        ),
        .testTarget(
            name: "LuxoraKitTests",
            dependencies: ["LuxoraKit", "LuxoraDesignFixtures"]
        ),
    ]
)
