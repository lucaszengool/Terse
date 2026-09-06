/* Runs the API on a port that is not 3000.
   .env pins PORT=3000, and that port is often busy on this machine (a Remotion
   render holds it while it works). Assigning after --env-file has been read is
   what makes this win. */
process.env.PORT = process.env.PHONE_PORT || '3200';
require('/Users/James/Desktop/Terse/.claude/worktrees/wp-test/api/server.js');
