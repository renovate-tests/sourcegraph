import { Selection } from '@sourcegraph/extension-api-types'
import { BehaviorSubject, Subscribable } from 'rxjs'
import { TextDocument } from 'sourcegraph'
import { TextDocumentPositionParams } from '../../protocol'

/**
 * Describes a code editor view component.
 *
 * @template D The type of text documents referred to by this data. If the document text is managed
 * out-of-band, this can just be an object containing the document URI.
 */
export interface CodeEditorData<D extends Pick<TextDocument, 'uri'> = TextDocument> {
    type: 'CodeEditor'
    item: D
    selections: Selection[]
    isActive: boolean
}

/**
 * The editor service manages editors and documents.
 */
export interface EditorService {
    /** All code editors. */
    readonly editors: Subscribable<readonly CodeEditorData[]>

    /** Transitional API for synchronously getting the list of code editors. */
    readonly editorsValue: readonly CodeEditorData[]

    /** Transitional API for setting the list of code editors. */
    nextEditors(value: readonly CodeEditorData[]): void
}

/**
 * Creates a {@link EditorService} instance.
 */
export function createEditorService(): EditorService {
    const editors = new BehaviorSubject<readonly CodeEditorData[]>([])
    return {
        editors,
        get editorsValue(): readonly CodeEditorData[] {
            return editors.value
        },
        nextEditors(value: readonly CodeEditorData[]): void {
            editors.next(value)
        },
    }
}

/**
 * Helper function to get the active editor's {@link TextDocumentPositionParams} from
 * {@link EditorService#editors}. If there is no active editor or it has no position, it returns
 * null.
 */
export function getActiveCodeEditorPosition<D extends Pick<TextDocument, 'uri'> = TextDocument>(
    editors: readonly CodeEditorData<D>[]
): (TextDocumentPositionParams & { textDocument: D }) | null {
    const activeEditor = editors.find(({ isActive }) => isActive)
    if (!activeEditor) {
        return null
    }
    const sel = activeEditor.selections[0]
    if (!sel) {
        return null
    }
    // TODO(sqs): Return null for empty selections (but currently all selected tokens are treated as an empty
    // selection at the beginning of the token, so this would break a lot of things, so we only do this for empty
    // selections when the start character is -1). HACK(sqs): Character === -1 means that the whole line is
    // selected (this is a bug in the caller, but it is useful here).
    const isEmpty =
        sel.start.line === sel.end.line && sel.start.character === sel.end.character && sel.start.character === -1
    if (isEmpty) {
        return null
    }
    return {
        textDocument: activeEditor.item,
        position: sel.start,
    }
}
