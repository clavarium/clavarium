/* A CONVERSATION NAME REACHES A COMMAND LINE: it becomes the tmux session
   name, and later the VM name. It is the only operator-chosen value that does,
   so it is validated here, strictly, and nowhere else. Lower-case letters,
   digits and hyphens; starts with a letter; no trailing hyphen. */
export const NAME_MAX = 32;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isConversationName(value) {
    return typeof value === 'string' && value.length <= NAME_MAX && NAME.test(value);
}
