# For a browser agent on a real desktop Chrome

Optional: a second look at clarity, after `npm run acceptance` passed. Paste
everything below the line, as it is, to the browser agent, with the address of
the test deployment in place of `<ADDRESS>`. The operator signs in himself when
asked; the agent never types a password.

---

You are checking a web app called Clavarium at <ADDRESS>, as a careful first-time
user. Do the steps in order. For each step, say: PASS or FAIL, what you saw in
one line, and a clarity opinion (clear / unclear, and why, in one sentence).
Never delete, archive or send anything; never click "Send", "Archive",
"Remove", "Restart" or "Change it". If a step asks for something you cannot do, say so and go on.

1. Open <ADDRESS>. Expected: a sign-in page. Ask me to sign in; wait until I say done. Expected: a list of conversations with a name at the top.
2. Read the list. Expected: each conversation shows its name, its tool, and a coloured dot. Is it clear which ones need attention?
3. Press "/". Expected: a search field, focused. Type the first letters of a conversation. Expected: only matching ones. Press Escape twice. Expected: the field empties, then closes.
4. Open the first conversation. Expected: its chat, with tabs Chat, Terminal, Assets, and a gear. Is it clear what each tab is?
5. Click the browser's Back button. Expected: the list again, not another site.
6. Open the conversation again, then Assets. Expected: its Git repositories and folders. Open a repository. Expected: "To send", "State", "Remote", branches drawn as a diagram, possibly a "Last checks" card.
7. Click "Open the review". Expected: what would be sent (or "Everything committed here is already there"). Do not click Send. Press Escape. Expected: back to the repository.
8. Click the gear. Expected: chapters (General, Machine, Access, ...). Expand Machine. Expected: memory and disk sizes, Restart, Sleep. Do not click them. Is it clear what a restart would do?
9. Bottom left: Access. Expected: a map of devices, conversations and assets, three "+" buttons and "All devices". Is the map understandable without help?
10. Bottom left: Settings. Expand General: the name of this Clavarium. Expand Updates: the version and the channel. Is it clear how updates happen?
11. Resize the window to a narrow width (about a phone's). Expected: one column, nothing cut, no sideways scrolling.
12. Summary: the three things a newcomer would find hardest, and one thing that is clearly good.
