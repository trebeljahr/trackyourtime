# Governance

This is a small project with one maintainer. This document says who decides
what, so nobody has to guess.

It describes no committee, no vote, no working group and no response-time
guarantee, because none of those exist. Inventing them would make this
document less useful, not more official.

## Who maintains it

**Rico Trebeljahr** ([@trebeljahr](https://github.com/trebeljahr),
<ricotrebeljahr@gmail.com>) — sole maintainer, final say on everything: scope,
design, what merges, and what gets released.

He works on this in his spare time. That is the honest framing for response
times too: there is no service level here. An issue or pull request may sit for
a while. A ping after a couple of weeks is welcome and not rude.

## How decisions get made

In the open, in issues and pull requests, and by one person.

- **Discussion happens in the issue.** That is why
  [CONTRIBUTING.md](CONTRIBUTING.md) asks you to open one before writing
  anything non-trivial: it is much cheaper to hear "out of scope" there than in
  a pull request you already finished.
- **Direction is written down in [ROADMAP.md](ROADMAP.md)**, split into what is
  wanted, what is undecided and what is deliberately out of scope. If your idea
  is not on it, the roadmap is not a closed list — say so in an issue.
- **The maintainer decides.** There is no vote, and no seniority to appeal to.

### When people disagree

Argue it in the thread, on the merits, under the
[Code of Conduct](CODE_OF_CONDUCT.md). Concrete beats abstract: a failing test,
a benchmark, a screenshot of the broken behaviour, a link to the line of code
in question. Most disagreements here are about scope rather than correctness,
and scope arguments are won by explaining who the change is for and what it
costs to maintain.

If the discussion does not converge, the maintainer decides and says why. That
decision closes the thread. Reopening the same argument in a new issue is not a
route around it.

If you disagree with a decision strongly enough, the licence has you covered:
fork it. That is a legitimate outcome, not a hostile one —
[TRADEMARK.md](TRADEMARK.md) explains how to do it cleanly, and "based on
Track Your Time" is an accurate and welcome thing for a fork to say.

## What gets a pull request merged

Four things, all of them checkable before you ask:

1. **Scope fits.** The change is a bug fix, a documentation correction, or
   something already agreed in an issue. Features that arrive as a surprise are
   the ones that get declined.
2. **CI is green.** See [CONTRIBUTING.md](CONTRIBUTING.md) for what runs and
   for the honest caveats about the parts of CI that are not currently
   reliable.
3. **Every commit is signed off** under the Developer Certificate of Origin —
   `git commit -s`. CI checks this on every non-merge commit.
4. **The maintainer has reviewed it.** One approving review, from one person.

Beyond that: one concern per pull request, and if your change makes a statement
in the documentation wrong, fix that statement in the same pull request.

## If your change is declined

It happens, and it is usually about scope rather than quality. A feature can be
well built, well tested and genuinely useful to you, and still be something
this project should not carry — because every merged feature is maintained
forever by one person in their spare time, across a web app, a browser
extension, a Raycast extension and a shared core package. "No" to a good patch
is a statement about that ongoing cost, not about your work or about you.

You will get a reason. If the reason is scope, [ROADMAP.md](ROADMAP.md) is
where it should already have been visible, and if it was not, that is a
documentation bug worth reporting.

And a declined change is still yours. AGPL-3.0-or-later is a licence to fork,
not just to read.

## Becoming a maintainer

There is no application and no committee. The path is the ordinary one:
contribute for a while, review other people's pull requests, and help with
issues you did not open. If someone is doing that consistently and their
judgement about scope matches the project's, the maintainer will offer commit
access and this document will be updated to name them.

Nobody has this today. If that changes, it changes here first.

## Licensing stance

These are settled positions, not open questions.

- **The code is AGPL-3.0-or-later** and stays that way. See
  [LICENSE](LICENSE).
- **Contributions run on the DCO, not a CLA.** You keep the copyright in
  everything you write. There is no agreement assigning your work to anyone and
  no form to sign — just a `Signed-off-by` trailer stating you have the right to
  submit it under the project's licence. The mechanics are in
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **No commercial-exception sales are planned.** Relicensing contributed code,
  or selling proprietary exceptions to it, would require rights over your work
  that the DCO deliberately does not collect. Choosing the DCO over a CLA
  forfeits that option, knowingly.
- **The marks are not covered by the licence.** The Track Your Time name, logo and
  domain are governed by [TRADEMARK.md](TRADEMARK.md), which restricts nothing
  the AGPL grants you over the code.

## Security

Security reports do not go through this process. Do not open a public issue —
follow [SECURITY.md](SECURITY.md), which routes them to a private GitHub
security advisory or to the maintainer's email.
