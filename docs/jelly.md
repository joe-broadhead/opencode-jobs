# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **Jobs** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link or
outside reference. The mark is a neutral bell on a slate tile. Jelly's declaration contracts drop a
top-level key they don't know, and refuse an unknown key inside a tool, sign-in or `contributes`
entry, so the section uses only the keys Jelly reads.

## Icons and the vendor

`opencode.icons` lists the same mark in three files of this package, in order: `assets/icon.svg`,
then `assets/icon-128.png` and `assets/icon-256.png`, each a raster rendered from that SVG and each
with its MCP `mimeType` and exact `sizes`. `jelly.icon` stays `assets/icon.svg`, the same file as
the first entry. The three files are also exported as `./icon.svg`, `./icon-128.png` and
`./icon-256.png`, so a consumer can resolve them from the installed package, and all three are in
the published tarball.

`opencode.vendor` is absent: Jobs is this family's own product, not a plugin over a vendor's
service, so there is no vendor logo to fetch and the package carries no vendor marks.

## Tools, skills and views

The declaration names no tools, skills, sign-ins, RPC or views: `jelly.tools`, `jelly.skills`,
`jelly.signIns`, `jelly.rpc` and `jelly.views` are empty, and `jelly.contributes` has no Home feed,
widget, work kind or setting. A job runs as the agent it names, with that agent's own permissions.
