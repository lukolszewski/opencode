import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { Permission } from "../permission"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file as a plain string value (NOT an array). For multi-line content, use newline characters (\\n) within the string."),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  }),
  formatValidationError(error, args) {
    const issues = error.issues.map((issue) => {
      const path = issue.path.join(".") || "root"
      if (issue.code === "invalid_type") {
        const invalidTypeIssue = issue as any
        return `  - ${path}: expected ${invalidTypeIssue.expected}, received ${invalidTypeIssue.received}`
      }
      return `  - ${path}: ${issue.message}`
    })

    // Check if content was passed as an array
    const isArray = Array.isArray(args?.content)
    const arrayHint = isArray
      ? `\n\nYou passed content as an array: ${JSON.stringify(args.content).slice(0, 100)}...\nDo NOT wrap the content in square brackets []. Pass the string directly.\nCorrect: content: "line1\\nline2\\nline3"\nWrong: content: ["line1\\nline2\\nline3"]`
      : ""

    return `Invalid write tool arguments:\n${issues.join("\n")}\n\nThe 'content' parameter must be a plain string value, NOT an array or object.${arrayHint}\n\nDEBUG: Received types - content: ${typeof args?.content}, filePath: ${typeof args?.filePath}`
  },
  async execute(params, ctx) {
    const agent = await Agent.get(ctx.agent)

    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    if (!Filesystem.contains(Instance.directory, filepath)) {
      const parentDir = path.dirname(filepath)
      if (agent.permission.external_directory === "ask") {
        await Permission.ask({
          type: "external_directory",
          pattern: [parentDir, path.join(parentDir, "*")],
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          title: `Write file outside working directory: ${filepath}`,
          metadata: {
            filepath,
            parentDir,
          },
        })
      } else if (agent.permission.external_directory === "deny") {
        throw new Permission.RejectedError(
          ctx.sessionID,
          "external_directory",
          ctx.callID,
          {
            filepath: filepath,
            parentDir,
          },
          `File ${filepath} is not in the current working directory`,
        )
      }
    }

    const file = Bun.file(filepath)
    const exists = await file.exists()
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    if (agent.permission.edit === "ask")
      await Permission.ask({
        type: "write",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: exists ? "Overwrite this file: " + filepath : "Create new file: " + filepath,
        metadata: {
          filePath: filepath,
          content: params.content,
          exists,
        },
      })

    await Bun.write(filepath, params.content)
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    FileTime.read(ctx.sessionID, filepath)

    let output = ""
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      if (issues.length === 0) continue
      const sorted = issues.toSorted((a, b) => (a.severity ?? 4) - (b.severity ?? 4))
      const limited = sorted.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        issues.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${issues.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === filepath) {
        output += `\nThis file has errors, please fix\n<file_diagnostics>\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</file_diagnostics>\n`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      output += `\n<project_diagnostics>\n${file}\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</project_diagnostics>\n`
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
