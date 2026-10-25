# PDF corpus sources

Third-party PDFs used by the corpus test suite. The files are **not** part of this repository;
`fetch-corpus.mjs` downloads them (pinned URLs, verified by sha256) into `$BERGWORK_PDF_CORPUS`
(default `~/AgentWork/bergwork-pdf-corpus`). Licence/terms per source are below; where a file's
licence differs from its source, the manifest entry carries its own `licence`.

Total: 1002 files, 1.22 GB (manifest generated 2026-10-25T10:45:44+00:00).

| Source id | Files | Size | Revision | Licence |
|---|---:|---:|---|---|
| `pdfjs` | 286 | 62.6 MB | `e2a5e1d34517` | Apache-2.0 (repository) |
| `pdfium` | 82 | 1.6 MB | `a84323421e94` | BSD-3-Clause |
| `qpdf` | 60 | 20.8 MB | `4eba95899886` | Apache-2.0 |
| `verapdf` | 100 | 7.6 MB | `bb75f4f0073d` | CC-BY-4.0 |
| `bfo-pdfa` | 12 | 4.0 MB | `c22d80260c7e` | no explicit licence |
| `pdf20examples` | 7 | 0.1 MB | `c20f2c17bfcc` | CC-BY-SA-4.0 |
| `pypdf-sample-files` | 30 | 13.4 MB | `02b8203bf416` | CC-BY-SA-4.0 |
| `pdfcpu` | 22 | 10.8 MB | `41c831809b39` | Apache-2.0 |
| `pdfbox` | 35 | 2.4 MB | `aa5a0b797e57` | Apache-2.0 |
| `pdf-lib` | 15 | 13.2 MB | `93dd36e85aa6` | MIT |
| `pypdf` | 20 | 9.4 MB | `0f196923094c` | BSD-3-Clause (repository) |
| `pikepdf` | 20 | 1.8 MB | `d55358f2d3c0` | per file (REUSE.toml) |
| `safedocs` | 19 | 0.5 MB | `68f730ab8c39` | Apache-2.0 |
| `zugferd` | 28 | 6.9 MB | `82e886fb2136` | Apache-2.0 |
| `arxiv` | 36 | 124.2 MB | `v1 of each paper (immutable)` | per paper (arXiv licence or CC) |
| `irs` | 27 | 16.5 MB | `irs-prior archive (year in file name)` | Public domain (US Government work) |
| `nasa-ntrs` | 26 | 78.3 MB | `2026-10-25` | Public domain (US Government work) |
| `usgs-topo` | 9 | 166.3 MB | `2026-10-25` | Public domain (US Government work) |
| `wikimedia-commons` | 67 | 394.1 MB | `2026-10-25` | per file (PD / CC0 / CC BY / CC BY-SA / OGL / GODL) |
| `ohchr-udhr` | 22 | 8.7 MB | `2026-10-25` | UDHR text free to reproduce |
| `internet-archive` | 9 | 241.8 MB | `2026-10-25` | Public domain (pre-1929 / not in copyright) |
| `govdocs1` | 70 | 36.9 MB | `threads/thread0.zip` | Public domain (US Government documents collected from .gov sites) |

## `pdfjs`: Mozilla pdf.js test corpus (test/pdfs, committed files only)

- Homepage: https://github.com/mozilla/pdf.js/tree/master/test/pdfs
- Revision: `e2a5e1d34517b7e544f234d54eec3aa37df0b846`
- Licence: Apache-2.0 (repository)
- Terms: Files committed to the public Apache-2.0 pdf.js repository for regression testing; mostly reduced documents from bug reports, individual documents keep their authors' copyright. Used here only for local testing, never redistributed.
- Notes: .link files (external URLs) were not used.
- Files taken: 286

## `pdfium`: PDFium testing/resources

- Homepage: https://pdfium.googlesource.com/pdfium/+/refs/heads/main/testing/resources/
- Revision: `a84323421e94f484faca52dd9d027934eba42ab8`
- Licence: BSD-3-Clause
- Terms: Test resources of the BSD-licensed PDFium project, fetched from the official GitHub mirror chromium/pdfium.
- Notes: Only committed .pdf files (not the .in templates). Passwords from the embedder tests (e.g. encrypted.pdf user 1234 / owner 5678, encrypted_hello_world_r*: user 'hôtel', owner 'âge').
- Files taken: 82

## `qpdf`: qpdf test suite (qpdf/qtest/qpdf)

- Homepage: https://github.com/qpdf/qpdf/tree/main/qpdf/qtest/qpdf
- Revision: `4eba95899886e851cc41d76886483b347612f2a8`
- Licence: Apache-2.0
- Terms: Test files of the Apache-2.0 qpdf project.
- Notes: Passwords from the qtest scripts (user/owner, view/master, ...).
- Files taken: 60

## `verapdf`: veraPDF corpus (PDF/A-1/2/3/4, PDF/UA-1/2, Isartor, TWG)

- Homepage: https://github.com/veraPDF/veraPDF-corpus
- Revision: `bb75f4f0073d9350dfd058c0162a367e6fadf25e`
- Licence: CC-BY-4.0
- Terms: Published under CC BY 4.0 by the veraPDF consortium / PDF Association as a public validation corpus; includes the Isartor PDF/A-1b test suite.
- Notes: Atomic pass/fail files; file name says pass/fail for the clause in its directory.
- Files taken: 100

## `bfo-pdfa`: BFO PDF/A-2 test suite

- Homepage: https://github.com/bfosupport/pdfa-testsuite
- Revision: `c22d80260c7ec975a511f9bfcc6590b7ceb1cf18`
- Licence: no explicit licence
- Terms: Publicly published by BFO as a PDF/A conformance test suite (referenced by the veraPDF corpus README); used only for local testing, not redistributed.
- Notes: description.txt in the repo explains each pass/fail case.
- Files taken: 12

## `pdf20examples`: PDF Association PDF 2.0 examples

- Homepage: https://github.com/pdf-association/pdf20examples
- Revision: `c20f2c17bfcc4baab7cfe62e70fae64caf14d5fa`
- Licence: CC-BY-SA-4.0
- Terms: Example files published under CC BY-SA 4.0 by the PDF Association.
- Files taken: 7

## `pypdf-sample-files`: py-pdf/sample-files

- Homepage: https://github.com/py-pdf/sample-files
- Revision: `02b8203bf416db3dbdb03438bc8278dfcb0555f3`
- Licence: CC-BY-SA-4.0
- Terms: Every PDF in the repository is CC BY-SA 4.0 (README).
- Notes: files.json in the repo has expected metadata.
- Files taken: 30

## `pdfcpu`: pdfcpu pkg/testdata

- Homepage: https://github.com/pdfcpu/pdfcpu/tree/master/pkg/testdata
- Revision: `41c831809b39ceb4f0240e053d3f579ac25db61a`
- Licence: Apache-2.0
- Terms: Test data of the Apache-2.0 pdfcpu project.
- Notes: Includes signed samples (pkg/testdata/signatures).
- Files taken: 22

## `pdfbox`: Apache PDFBox test resources

- Homepage: https://github.com/apache/pdfbox
- Revision: `aa5a0b797e5793e023a3b3c247465cb11b8a66b3`
- Licence: Apache-2.0
- Terms: Test resources of the Apache PDFBox project (ASF, Apache-2.0).
- Notes: Encryption samples: user 'user' / owner 'owner'.
- Files taken: 35

## `pdf-lib`: pdf-lib test assets

- Homepage: https://github.com/Hopding/pdf-lib/tree/master/assets/pdfs
- Revision: `93dd36e85aa659a3bca09867d2d8fac172501fbe`
- Licence: MIT
- Terms: Assets of the MIT-licensed pdf-lib repository.
- Files taken: 15

## `pypdf`: pypdf resources

- Homepage: https://github.com/py-pdf/pypdf/tree/main/resources
- Revision: `0f196923094c27d53697399f22798a73fd70c601`
- Licence: BSD-3-Clause (repository)
- Terms: Test resources committed to the BSD-licensed pypdf repository.
- Files taken: 20

## `pikepdf`: pikepdf tests/resources

- Homepage: https://github.com/pikepdf/pikepdf/tree/main/tests/resources
- Revision: `d55358f2d3c0a15f613dde4c2e8babe75515d461`
- Licence: per file (REUSE.toml)
- Terms: Only files with an explicit licence in the repository's REUSE.toml were taken; the per-file licence is recorded in each entry.
- Files taken: 20

## `safedocs`: PDF Association SafeDocs targeted test PDFs

- Homepage: https://github.com/pdf-association/safedocs
- Revision: `68f730ab8c39204844112c499c5707b79878533b`
- Licence: Apache-2.0
- Terms: Published by the PDF Association under Apache-2.0 (DARPA SafeDocs, approved for public release).
- Notes: Unicode password tests: see the repo README for passwords.
- Files taken: 19

## `zugferd`: ZUGFeRD / Factur-X / XRechnung sample invoices

- Homepage: https://github.com/ZUGFeRD/corpus
- Revision: `82e886fb21369e3e83c1e97170a4ff406deceee7`
- Licence: Apache-2.0
- Terms: Apache-2.0 corpus of sample/test e-invoices; only the sample folders (XML-Rechnung, ZUGFeRDv1/v2 correct+fail from FeRD, FNFE, Mustang, intarsys) were used, not 'incoming'/'unstructured' real invoices.
- Notes: PDF/A-3 with embedded XML invoices.
- Files taken: 28

## `arxiv`: arXiv papers

- Homepage: https://arxiv.org
- Revision: `v1 of each paper (immutable)`
- Licence: per paper (arXiv licence or CC)
- Terms: Individual papers downloaded from arxiv.org/pdf (allowed by robots.txt, crawl delay 15 s respected); arXiv's distribution licence permits reading/downloading, not redistribution, so they are only referenced by URL.
- Notes: Versions pinned to v1.
- Files taken: 36

## `irs`: US IRS tax forms and publications (prior-year archive)

- Homepage: https://www.irs.gov/prior-year-forms-and-instructions
- Revision: `irs-prior archive (year in file name)`
- Licence: Public domain (US Government work)
- Terms: Works of the US federal government are not subject to copyright (17 U.S.C. 105); irs-prior URLs are stable per year.
- Notes: AcroForm + XFA hybrid forms, PDF/UA tagged forms, scanned historic forms.
- Files taken: 27

## `nasa-ntrs`: NASA Technical Reports Server

- Homepage: https://ntrs.nasa.gov
- Revision: `2026-10-25`
- Licence: Public domain (US Government work)
- Terms: Only records whose NTRS copyright determination is GOV_PUBLIC_USE_PERMITTED; robots.txt allows crawling.
- Notes: 1960s scanned reports with OCR layer, modern presentations.
- Files taken: 26

## `usgs-topo`: USGS US Topo and Historical Topographic Map GeoPDFs

- Homepage: https://www.usgs.gov/programs/national-geospatial-program/topographic-maps
- Revision: `2026-10-25`
- Licence: Public domain (US Government work)
- Terms: USGS products are in the public domain; fetched from the official TNM S3 bucket.
- Notes: Layered GeoPDF (OCGs), vector-heavy, large.
- Files taken: 9

## `wikimedia-commons`: Wikimedia Commons PDF files

- Homepage: https://commons.wikimedia.org
- Revision: `2026-10-25`
- Licence: per file (PD / CC0 / CC BY / CC BY-SA / OGL / GODL)
- Terms: Freely licensed files; licence of each file recorded per entry from the Commons API (LicenseShortName); downloaded from upload.wikimedia.org with an identifying User-Agent.
- Notes: Non-Latin scripts, presentations, maps, CAD drawings, scanned books.
- Files taken: 67

## `ohchr-udhr`: Universal Declaration of Human Rights translations (OHCHR)

- Homepage: https://www.ohchr.org/en/human-rights/universal-declaration/universal-declaration-human-rights/about-universal-declaration-human-rights-translation-project
- Revision: `2026-10-25`
- Licence: UDHR text free to reproduce
- Terms: The UDHR translations are published by OHCHR for free dissemination; files are fetched individually.
- Notes: Many scripts; several older files use non-Unicode fonts (text not extractable).
- Files taken: 22

## `internet-archive`: Internet Archive public-domain scans

- Homepage: https://archive.org
- Revision: `2026-10-25`
- Licence: Public domain (pre-1929 / not in copyright)
- Terms: Public-domain books from archive.org (robots.txt allows /download).
- Notes: Large OCR'd scans (JBIG2/JPX), many pages.
- Files taken: 9

## `govdocs1`: Digital Corpora govdocs1 (thread0.zip subset)

- Homepage: https://digitalcorpora.org/corpora/file-corpora/files/
- Revision: `threads/thread0.zip`
- Licence: Public domain (US Government documents collected from .gov sites)
- Terms: govdocs1 is distributed by Digital Corpora for research use without restrictions; members are extracted from the zip with HTTP range requests.
- Notes: Real-world 2000s-era PDFs from many producers.
- Files taken: 70

## Selection

Test-suite repositories were cloned at the pinned commit, every PDF was tagged with `tag-corpus.py`,
and a greedy rarity-weighted selection picked a subset per source that maximises tag/producer/
encryption/annotation-type coverage. Encrypted files whose password is not known were dropped.
Real-world documents (arXiv, IRS, NASA NTRS, USGS, Wikimedia Commons, OHCHR, Internet Archive,
govdocs1) were chosen by hand for genre/script/size coverage. No paywalled content, no personal data.
