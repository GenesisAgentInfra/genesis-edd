# Third-party dependencies

Genesis EDD source is licensed under Apache-2.0.

OpenSpec (`@fission-ai/openspec`, pinned to 2.1.0) is an external MIT-licensed
dependency maintained by Fission AI. Its source is not vendored or modified.
The Genesis-specific workflow, templates and skill in this repository are authored
for this integration. OpenSpec's original package retains its own license and
notices in `node_modules/@fission-ai/openspec/` after installation.

- Upstream: https://github.com/Fission-AI/OpenSpec
- Package: https://www.npmjs.com/package/@fission-ai/openspec
- Integration documentation: https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md

Harbor (`harbor`, Apache-2.0) runs eval packages. It is a separate tool the user
installs; it is not a dependency of this package and its source is not vendored.

- Upstream: https://github.com/harbor-framework/harbor
- Documentation: https://docs.harborframework.com

The environment and verifier guidance in `skills/write-eval/references/` adapts
methods from the MIT-licensed `langchain-eval-engineering` skill by LangChain.
The text is written for this project; no file is copied from it.

- Upstream: https://github.com/langchain-ai/langchain-skills

The direct `yaml` dependency is ISC-licensed. Transitive packages retain their
respective licenses. Exact versions and integrity hashes are in `package-lock.json`.
