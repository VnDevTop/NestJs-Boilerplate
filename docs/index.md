# Documentation

Guides for running this boilerplate. Everything here is configuration or
deployment; the code itself is documented where it lives, and the repository
README covers what the template contains.

## Guides

| Guide                                             | Covers                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Production hardening](production.md)             | rate limiting, headers, CORS, request ids, logging, health, shutdown, env validation, migrations, Docker, CI |
| [Optional integrations](optional-integrations.md) | how a feature can exist in the code without its package on disk, and how to enable one                       |

## Where the rest of the writing lives

These stay in the repository root rather than here, because they are about this
project rather than about running it. GitHub renders them on their own pages:

| File                                                                                       | About                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [README](https://github.com/VnDevTop/NestJs-Boilerplate/blob/master/README.md)             | what the template contains and how to start it |
| [PLAN](https://github.com/VnDevTop/NestJs-Boilerplate/blob/master/PLAN.md)                 | the phase-by-phase build plan and its status   |
| [ROADMAP](https://github.com/VnDevTop/NestJs-Boilerplate/blob/master/ROADMAP.md)           | what comes after the current phases            |
| [CONTRIBUTING](https://github.com/VnDevTop/NestJs-Boilerplate/blob/master/CONTRIBUTING.md) | how to propose a change                        |
| [SECURITY](https://github.com/VnDevTop/NestJs-Boilerplate/blob/master/SECURITY.md)         | how to report a vulnerability                  |
| [CHANGELOG](https://github.com/VnDevTop/NestJs-Boilerplate/blob/master/CHANGELOG.md)       | released changes                               |

## Configuration reference

There is no separate reference page: `.env.example` is the reference. Every
variable in it carries a comment saying what it does, what it defaults to, and
what breaks if it is set wrong, and the app refuses to start on a value that
fails validation rather than falling back to a default nobody chose.

## A note on how this site is built

It is not. GitHub runs Jekyll over the repository on every push, so there is no
build step to run locally and nothing to keep in sync with a generator. Pages is
set to publish the repository root, which has two consequences worth knowing.

- **Every markdown file in the repository is rendered, not just this folder.**
  `README.md` becomes the site index and `PLAN.md`, `ROADMAP.md` and the rest
  each become a page. A mistake in any of them fails the whole build, which is
  why `PLAN.md` spells out Handlebars' brace forms in words.
- **Do not add a `.nojekyll` file.** It tells GitHub to skip Jekyll and serve
  every file exactly as it sits on disk, which means the markdown arrives as
  plain text instead of a rendered page. The site only works because Jekyll is
  doing the rendering.

If the docs ever outgrow what the repository root can carry, the alternative is
to point Pages at this folder alone and generate the markdown properly. Nothing
here is written in a way that would have to be rewritten to move.
