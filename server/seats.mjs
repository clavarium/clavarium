/* ONE PERSON AT A TIME. A conversation has one active screen; the newest one
   takes the seat and the previous one is told, then waits.
 *
 * Why not several viewers: a terminal has ONE size. Measured with two screens
 * of different sizes attached at once, the larger one shrank to a strip of the
 * smaller one's width. One seat removes the question. */
export class Seats {
    #taken = new Map();

    /* Seats `viewer` on `name` and returns whoever was there, or undefined. */
    take(name, viewer) {
        const previous = this.#taken.get(name);
        this.#taken.set(name, viewer);
        return previous === viewer ? undefined : previous;
    }

    /* Frees the seat only if `viewer` still holds it: a viewer that was taken
       over must not, by leaving, unseat the one who replaced it. */
    leave(name, viewer) {
        if (this.#taken.get(name) === viewer) this.#taken.delete(name);
    }

    holder(name) { return this.#taken.get(name); }
}
