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
    targets: [
        .target(
            name: "LuxoraKit",
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
