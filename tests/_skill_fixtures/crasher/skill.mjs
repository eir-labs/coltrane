// Never returns. The executor's timeout must kill this subprocess (SIGKILL after the
// grace window) and report ok:false instead of hanging the calling gig forever.
export default function run() {
  while (true) {
    /* spin */
  }
}
