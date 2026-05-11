package dev.kimchi.jetbrains.diff

import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.MarkupModel
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.ui.JBColor
import java.awt.Color

class InlineDiffHighlighting : EditorFactoryListener, Disposable {

    private val diffHighlighters = mutableMapOf<Editor, MutableList<RangeHighlighter>>()

    companion object {
        private val ADDED_COLOR = JBColor(Color(173, 255, 173), Color(27, 80, 27))
        private val REMOVED_COLOR = JBColor(Color(255, 173, 173), Color(80, 27, 27))
        private val MODIFIED_COLOR = JBColor(Color(255, 255, 173), Color(80, 80, 27))

        private val INSTANCE: InlineDiffHighlighting? = null

        fun getInstance(): InlineDiffHighlighting {
            return INSTANCE ?: InlineDiffHighlighting().also {
                EditorFactory.getInstance().addEditorFactoryListener(it, it)
            }
        }
    }

    fun showDiff(editor: Editor, changes: List<DiffChange>) {
        clearHighlighters(editor)

        val markupModel = editor.markupModel
        val highlighters = mutableListOf<RangeHighlighter>()

        for (change in changes) {
            val highlighter = when (change.type) {
                ChangeType.ADDED -> createAddedHighlighter(markupModel, change)
                ChangeType.REMOVED -> createRemovedHighlighter(markupModel, change)
                ChangeType.MODIFIED -> createModifiedHighlighter(markupModel, change)
            }
            highlighters.add(highlighter)
        }

        diffHighlighters[editor] = highlighters
    }

    fun clearHighlighters(editor: Editor) {
        diffHighlighters[editor]?.forEach { it.dispose() }
        diffHighlighters.remove(editor)
    }

    private fun createAddedHighlighter(markupModel: MarkupModel, change: DiffChange): RangeHighlighter {
        val attributes = TextAttributes().apply {
            backgroundColor = ADDED_COLOR
        }

        return markupModel.addRangeHighlighter(
            change.startOffset,
            change.endOffset,
            HighlighterLayer.LAST + 1,
            attributes,
            HighlighterTargetArea.LINES_IN_RANGE
        )
    }

    private fun createRemovedHighlighter(markupModel: MarkupModel, change: DiffChange): RangeHighlighter {
        val attributes = TextAttributes().apply {
            backgroundColor = REMOVED_COLOR
            effectType = com.intellij.openapi.editor.markup.EffectType.STRIKEOUT
        }

        return markupModel.addRangeHighlighter(
            change.startOffset,
            change.endOffset,
            HighlighterLayer.LAST + 1,
            attributes,
            HighlighterTargetArea.LINES_IN_RANGE
        )
    }

    private fun createModifiedHighlighter(markupModel: MarkupModel, change: DiffChange): RangeHighlighter {
        val attributes = TextAttributes().apply {
            backgroundColor = MODIFIED_COLOR
        }

        return markupModel.addRangeHighlighter(
            change.startOffset,
            change.endOffset,
            HighlighterLayer.LAST + 1,
            attributes,
            HighlighterTargetArea.LINES_IN_RANGE
        )
    }

    override fun editorCreated(event: EditorFactoryEvent) {}
    override fun editorReleased(event: EditorFactoryEvent) {
        clearHighlighters(event.editor)
    }

    override fun dispose() {
        diffHighlighters.values.forEach { highlighters ->
            highlighters.forEach { it.dispose() }
        }
        diffHighlighters.clear()
    }
}