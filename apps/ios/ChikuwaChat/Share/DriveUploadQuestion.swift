import SwiftUI

/// A name taken in the folder (docs/DRIVE.md §6.2, §17.3, §29): 「上書きして新しいバージョンにする / 名前を変えて両方残す /
/// スキップ」, with 「残りすべてに同じ操作」 when more of the batch are still to go. Shared by the app and the Share
/// Extension (each target's catalog holds the texts).
struct DriveUploadQuestion: Identifiable, Equatable {
    var batchId: String
    var jobId: String
    var name: String
    /// Where it goes (「研究室ドライブ › 論文」).
    var place: String
    /// "folder": a folder of that name takes no version.
    var existingKind: String?
    /// The rest of the batch still to go (the 「すべてに」 switch shows when > 0).
    var remaining: Int
    var id: String { jobId }

    /// The first job of these batches that waits for an answer.
    static func first(in batches: [DriveUploadBatch]) -> DriveUploadQuestion? {
        for batch in batches {
            guard let job = batch.jobs.first(where: { $0.state == .asking }) else { continue }
            let remaining = batch.jobs.filter { $0.id != job.id && !$0.state.isFinished }.count
            return DriveUploadQuestion(batchId: batch.id, jobId: job.id, name: job.name, place: batch.target.label,
                                       existingKind: job.existingKind, remaining: remaining)
        }
        return nil
    }
}

struct DriveUploadQuestionView: View {
    let question: DriveUploadQuestion
    let answer: (DriveConflictChoice, Bool) -> Void
    @State private var all = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("同じ名前のファイルがあります").font(.headline)
            Text("「\(question.name)」は「\(question.place)」にすでにあります。")
                .font(.subheadline).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 8) {
                if question.existingKind != "folder" {
                    Button { answer(.version, all) } label: { Text("上書きして新しいバージョンにする").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("drive.conflict.version")
                }
                Button { answer(.rename, all) } label: { Text("名前を変えて両方残す").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("drive.conflict.rename")
                Button { answer(.skip, all) } label: { Text("スキップ").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("drive.conflict.skip")
            }
            if question.remaining > 0 {
                Toggle("残りすべてに同じ操作", isOn: $all)
                    .font(.subheadline)
            }
        }
        .padding(20)
        .presentationDetents([.height(question.remaining > 0 ? 330 : 280)])
        .interactiveDismissDisabled()
    }
}
