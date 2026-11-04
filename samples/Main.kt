package demo

data class Note(val id: Int, val text: String, val pinned: Boolean = false)

sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>
    data class Err(val message: String) : Result<Nothing>
}

fun parse(input: String): Result<Int> =
    input.toIntOrNull()?.let { Result.Ok(it) } ?: Result.Err("not a number: $input")

fun main() {
    val notes = listOf(Note(1, "fold me"), Note(2, "zoom me", pinned = true))
    notes.filter { it.pinned }.forEach { println("pinned: ${it.text}") }
    when (val r = parse("42")) {
        is Result.Ok -> println("ok ${r.value}")
        is Result.Err -> println(r.message)
    }
}
