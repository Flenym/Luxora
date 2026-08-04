#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit

@MainActor
struct ProfileAvatarEditor: View {
    let displayName: String
    @Binding var avatarPNGData: Data?

    @State private var pickerItem: PhotosPickerItem?
    @State private var cropSource: UIImage?
    @State private var isCropperPresented = false
    @State private var loadError: String?

    var body: some View {
        let previewData = avatarPNGData
        PhotosPicker(selection: $pickerItem, matching: .images, photoLibrary: .shared()) {
            ZStack(alignment: .bottomTrailing) {
                OnboardingAvatarPreview(displayName: displayName, avatarPNGData: previewData)
                    .frame(width: 112, height: 112)

                Image(systemName: "camera.fill")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(LuxoraTheme.accent, in: Circle())
                    .overlay(Circle().stroke(Color.black, lineWidth: 3))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(avatarPNGData == nil ? "Добавить фото профиля" : "Изменить фото профиля")
        .accessibilityIdentifier("auth-avatar-picker")
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task { @MainActor in
                do {
                    guard let data = try await item.loadTransferable(type: Data.self),
                          let image = UIImage(data: data)
                    else {
                        loadError = "Не удалось открыть выбранное изображение."
                        return
                    }
                    cropSource = image.normalizedForDisplay
                    isCropperPresented = true
                } catch is CancellationError {
                    return
                } catch {
                    loadError = "Не удалось открыть выбранное изображение."
                }
            }
        }
        .fullScreenCover(isPresented: $isCropperPresented) {
            if let cropSource {
                CircularAvatarCropper(image: cropSource) { result in
                    if let result {
                        avatarPNGData = result
                    }
                    isCropperPresented = false
                    pickerItem = nil
                    self.cropSource = nil
                }
            }
        }
        .alert("Фото недоступно", isPresented: Binding(
            get: { loadError != nil },
            set: { if !$0 { loadError = nil } }
        )) {
            Button("ОК", role: .cancel) { loadError = nil }
        } message: {
            Text(loadError ?? "")
        }
    }
}

private struct OnboardingAvatarPreview: View {
    let displayName: String
    let avatarPNGData: Data?

    var body: some View {
        Group {
            if let avatarPNGData,
               let image = UIImage(data: avatarPNGData)
            {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Circle()
                    .fill(defaultGradient)
                    .overlay {
                        Text(initial)
                            .font(.system(size: 42, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                    }
            }
        }
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 1))
    }

    private var initial: String {
        displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            .first
            .map { String($0).uppercased() } ?? "L"
    }

    private var defaultGradient: LinearGradient {
        let palettes: [(Color, Color)] = [
            (Color(hex: 0x725CFF), Color(hex: 0x4A2AC7)),
            (Color(hex: 0x2E9BFF), Color(hex: 0x1762C8)),
            (Color(hex: 0x00AFA0), Color(hex: 0x08736B)),
            (Color(hex: 0xE46A92), Color(hex: 0x9F315C)),
            (Color(hex: 0xE58B35), Color(hex: 0xA44D16)),
            (Color(hex: 0x7C8CFF), Color(hex: 0x3A49B5)),
        ]
        let index = Int(stableHash(displayName) % UInt64(palettes.count))
        return LinearGradient(
            colors: [palettes[index].0, palettes[index].1],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private func stableHash(_ value: String) -> UInt64 {
        value.lowercased().unicodeScalars.reduce(14_695_981_039_346_656_037) { hash, scalar in
            (hash ^ UInt64(scalar.value)) &* 1_099_511_628_211
        }
    }
}

private struct CircularAvatarCropper: View {
    let image: UIImage
    let completion: (Data?) -> Void

    @State private var zoom: CGFloat = 1
    @State private var committedZoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var committedOffset: CGSize = .zero

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let diameter = min(geometry.size.width - 40, 390)

                VStack(spacing: 24) {
                    Spacer(minLength: 24)

                    AvatarCropCanvas(
                        image: image,
                        diameter: diameter,
                        zoom: zoom,
                        offset: offset
                    )
                    .frame(width: diameter, height: diameter)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.72), lineWidth: 2))
                    .shadow(color: .black.opacity(0.4), radius: 18)
                    .gesture(cropGesture(diameter: diameter))
                    .accessibilityLabel("Круглая область кадрирования")
                    .accessibilityIdentifier("auth-avatar-crop")

                    Label("Сведите пальцы для масштаба и перетащите фото", systemImage: "hand.draw")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Slider(value: $zoom, in: 1...4)
                        .tint(LuxoraTheme.iris)
                        .padding(.horizontal, 30)
                        .accessibilityLabel("Масштаб фото")
                        .accessibilityIdentifier("auth-avatar-zoom")
                        .onChange(of: zoom) { _, value in committedZoom = value }

                    Spacer(minLength: 20)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.ignoresSafeArea())
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Отмена") { completion(nil) }
                            .accessibilityIdentifier("auth-avatar-crop-cancel")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Готово") {
                            completion(renderedAvatar(diameter: diameter))
                        }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("auth-avatar-crop-done")
                    }
                }
                .navigationTitle("Фото профиля")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .preferredColorScheme(.dark)
    }

    private func cropGesture(diameter: CGFloat) -> some Gesture {
        SimultaneousGesture(
            MagnifyGesture()
                .onChanged { value in
                    zoom = min(4, max(1, committedZoom * value.magnification))
                }
                .onEnded { _ in committedZoom = zoom },
            DragGesture()
                .onChanged { value in
                    offset = clamped(
                        CGSize(
                            width: committedOffset.width + value.translation.width,
                            height: committedOffset.height + value.translation.height
                        ),
                        diameter: diameter
                    )
                }
                .onEnded { _ in committedOffset = offset }
        )
    }

    private func clamped(_ candidate: CGSize, diameter: CGFloat) -> CGSize {
        let limit = diameter * 0.42
        return CGSize(
            width: min(limit, max(-limit, candidate.width)),
            height: min(limit, max(-limit, candidate.height))
        )
    }

    @MainActor
    private func renderedAvatar(diameter: CGFloat) -> Data? {
        let outputSize: CGFloat = 512
        let ratio = outputSize / diameter
        let renderer = ImageRenderer(
            content: AvatarCropCanvas(
                image: image,
                diameter: outputSize,
                zoom: zoom,
                offset: CGSize(width: offset.width * ratio, height: offset.height * ratio)
            )
            .frame(width: outputSize, height: outputSize)
            .clipShape(Circle())
        )
        renderer.proposedSize = ProposedViewSize(width: outputSize, height: outputSize)
        renderer.scale = 1
        return renderer.uiImage?.pngData()
    }
}

private struct AvatarCropCanvas: View {
    let image: UIImage
    let diameter: CGFloat
    let zoom: CGFloat
    let offset: CGSize

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: diameter, height: diameter)
            .scaleEffect(zoom)
            .offset(offset)
            .frame(width: diameter, height: diameter)
            .clipped()
    }
}

enum PendingProfileAvatarStore {
    static func save(_ data: Data) throws {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appendingPathComponent("Luxora", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent("pending-profile-avatar.png"), options: .atomic)
    }
}

private extension UIImage {
    var normalizedForDisplay: UIImage {
        guard imageOrientation != .up else { return self }
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: size)) }
    }
}
#endif
