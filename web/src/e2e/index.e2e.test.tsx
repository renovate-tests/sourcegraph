import { percySnapshot as realPercySnapshot } from '@percy/puppeteer'
import * as os from 'os'
import * as path from 'path'
import puppeteer, { LaunchOptions } from 'puppeteer'
import { Key } from 'ts-key-enum'
import * as util from 'util'
import { saveScreenshotsUponFailuresAndClosePage } from '../../../shared/src/util/screenshotReporter'
import { readEnvBoolean, readEnvString, retry } from '../util/e2e-test-utils'

// 1 minute test timeout. This must be greater than the default Puppeteer
// command timeout of 30s in order to get the stack trace to point to the
// Puppeteer command that failed instead of a cryptic Jest test timeout
// location.
jest.setTimeout(1 * 60 * 1000)

// tslint:disable-next-line: no-empty
const noopPercySnapshot: typeof realPercySnapshot = async () => {}
const percySnapshot = readEnvBoolean({ variable: 'PERCY_ON', defaultValue: false })
    ? realPercySnapshot
    : noopPercySnapshot

process.on('unhandledRejection', error => {
    console.error('Caught unhandledRejection:', error)
})

process.on('rejectionHandled', error => {
    console.error('Caught rejectionHandled:', error)
})

/**
 * Used in the external service configuration.
 */
export const gitHubToken = readEnvString({ variable: 'GITHUB_TOKEN' })

describe('e2e test suite', function(this: any): void {
    const baseURL = readEnvString({ variable: 'SOURCEGRAPH_BASE_URL', defaultValue: 'http://localhost:3080' })

    let browser: puppeteer.Browser
    let page: puppeteer.Page

    async function init(): Promise<void> {
        await ensureLoggedIn()

        const repoSlugs = [
            'gorilla/mux',
            'gorilla/securecookie',
            'sourcegraphtest/AlwaysCloningTest',
            'sourcegraph/godockerize',
            'sourcegraph/jsonrpc2',
            'sourcegraph/checkup',
            'sourcegraph/go-diff',
            'sourcegraph/vcsstore',
            'sourcegraph/go-vcs',
        ]
        await ensureHasExternalService(
            'github',
            'e2e-test-github',
            JSON.stringify({
                url: 'https://github.com',
                token: gitHubToken,
                repos: repoSlugs,
                repositoryQuery: ['none'],
            }),
            repoSlugs
        )
    }

    // Start browser.
    beforeAll(
        async () => {
            let args: string[] = []
            if (process.getuid() === 0) {
                // TODO don't run as root in CI
                console.warn('Running as root, disabling sandbox')
                args = ['--no-sandbox', '--disable-setuid-sandbox']
            }
            const launchOpt: LaunchOptions = {
                args: [...args, '--window-size=1280,1024'],
                headless: readEnvBoolean({ variable: 'HEADLESS', defaultValue: false }),
            }
            browser = await puppeteer.launch(launchOpt)
            page = await browser.newPage()
            page.on('console', message =>
                console.log(
                    'Browser console message:',
                    util.inspect(message, { colors: true, depth: 2, breakLength: Infinity })
                )
            )
            await init()
        },
        // Cloning the repositories takes ~1 minute, so give initialization 2
        // minutes instead of 1 (which would be inherited from
        // `jest.setTimeout(1 * 60 * 1000)` above).
        2 * 60 * 1000
    )

    // Close browser.
    afterAll(async () => {
        if (browser) {
            await browser.close()
        }
    })

    async function ensureLoggedIn(): Promise<void> {
        await page.goto(baseURL)
        await page.evaluate(() => {
            localStorage.setItem('has-dismissed-browser-ext-toast', 'true')
            localStorage.setItem('has-dismissed-integrations-toast', 'true')
            localStorage.setItem('has-dismissed-survey-toast', 'true')
        })
        const url = new URL(await page.url())
        if (url.pathname === '/site-admin/init') {
            await page.type('input[name=email]', 'test@test.com')
            await page.type('input[name=username]', 'test')
            await page.type('input[name=password]', 'test')
            await page.click('button[type=submit]')
            await page.waitForNavigation()
        } else if (url.pathname === '/sign-in') {
            await page.type('input', 'test')
            await page.type('input[name=password]', 'test')
            await page.click('button[type=submit]')
            await page.waitForNavigation()
        }
    }

    /**
     * Specifies how `replaceText` will select the content of the element. No
     * single method works in all cases:
     *
     * - Meta+A doesn't work in input boxes https://github.com/GoogleChrome/puppeteer/issues/1313
     * - selectall doesn't work in the Monaco editor
     */
    type ReplaceTextMethod = 'selectall' | 'keyboard'

    async function replaceText({
        selector,
        newText,
        method = 'selectall',
    }: {
        selector: string
        newText: string
        method?: ReplaceTextMethod
    }): Promise<void> {
        const selectAllByMethod: Record<ReplaceTextMethod, () => Promise<void>> = {
            selectall: async () => {
                await page.evaluate(() => document.execCommand('selectall', false))
            },
            keyboard: async () => {
                const modifier = os.platform() === 'darwin' ? Key.Meta : Key.Control
                await page.keyboard.down(modifier)
                await page.keyboard.press('a')
                await page.keyboard.up(modifier)
            },
        }

        // The Monaco editor sometimes detaches nodes from the DOM, causing
        // `click()` to fail unpredictably.
        await retry(async () => {
            await page.waitForSelector(selector)
            await page.click(selector)
        })
        await selectAllByMethod[method]()
        await page.keyboard.press(Key.Backspace)
        await page.keyboard.type(newText)
    }

    async function ensureHasExternalService(
        kind: string,
        displayName: string,
        config: string,
        ensureRepos?: string[]
    ): Promise<void> {
        await page.goto(baseURL + '/site-admin/external-services')
        await page.waitFor('.e2e-filtered-connection')
        await page.waitForSelector('.e2e-filtered-connection__loader', { hidden: true })

        // Matches buttons for deleting external services named ${displayName}.
        const deleteButtonSelector = `[data-e2e-external-service-name="${displayName}"] .e2e-delete-external-service-button`
        if (await page.$(deleteButtonSelector)) {
            const accept = async (dialog: puppeteer.Dialog) => {
                await dialog.accept()
                page.off('dialog', accept)
            }
            page.on('dialog', accept)
            await page.click(deleteButtonSelector)
        }

        await (await page.waitForSelector('.e2e-goto-add-external-service-page', { visible: true })).click()

        await (await page.waitForSelector(`.linked-external-service-card--${kind}`, { visible: true })).click()

        await replaceText({ selector: '#e2e-external-service-form-display-name', newText: displayName })

        // Type in a new external service configuration.
        await replaceText({
            selector: '.view-line',
            newText: config,
            method: 'keyboard',
        })
        await page.click('.e2e-add-external-service-button')
        await page.waitForNavigation()

        if (ensureRepos) {
            // Wait for repositories to sync.
            await page.goto(baseURL + '/site-admin/repositories?query=gorilla%2Fmux')
            await retry(async () => {
                await page.reload()
                await page.waitForSelector(`.repository-node[data-e2e-repository='github.com/gorilla/mux']`, {
                    timeout: 5000,
                })
            })

            // Clone the repositories
            for (const slug of ensureRepos) {
                await page.goto(baseURL + `/site-admin/repositories?query=${encodeURIComponent(slug)}`)
                await page.waitForSelector(`.repository-node[data-e2e-repository='github.com/${slug}']`, {
                    visible: true,
                })
            }
        }
    }

    // Take a screenshot when a test fails.
    saveScreenshotsUponFailuresAndClosePage(
        path.resolve(__dirname, '..', '..', '..'),
        path.resolve(__dirname, '..', '..', '..', 'puppeteer'),
        () => page
    )

    const assertWindowLocation = async (location: string, isAbsolute = false): Promise<any> => {
        const url = isAbsolute ? location : baseURL + location
        await retry(async () => {
            expect(await page.evaluate(() => window.location.href)).toEqual(url)
        })
    }

    const assertWindowLocationPrefix = async (locationPrefix: string, isAbsolute = false): Promise<any> => {
        const prefix = isAbsolute ? locationPrefix : baseURL + locationPrefix
        await retry(async () => {
            const loc: string = await page.evaluate(() => window.location.href)
            expect(loc.startsWith(prefix)).toBeTruthy()
        })
    }

    const assertStickyHighlightedToken = async (label: string): Promise<void> => {
        await page.waitForSelector('.selection-highlight-sticky', { visible: true }) // make sure matched token is highlighted
        await retry(async () =>
            expect(
                await page.evaluate(() => document.querySelector('.selection-highlight-sticky')!.textContent)
            ).toEqual(label)
        )
    }

    const assertAllHighlightedTokens = async (label: string): Promise<void> => {
        const highlightedTokens = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.selection-highlight')).map(el => el.textContent || '')
        )
        expect(highlightedTokens.every(txt => txt === label)).toBeTruthy()
    }

    const assertNonemptyLocalRefs = async (): Promise<void> => {
        // verify active group is references
        await page.waitForXPath(
            "//*[contains(@class, 'panel__tabs')]//*[contains(@class, 'tab-bar__tab--active') and contains(text(), 'References')]"
        )
        // verify there are some references
        await page.waitForSelector('.panel__tabs-content .file-match-children__item', { visible: true })
    }

    const assertNonemptyExternalRefs = async (): Promise<void> => {
        // verify active group is references
        await page.waitForXPath(
            "//*[contains(@class, 'panel__tabs')]//*[contains(@class, 'tab-bar__tab--active') and contains(text(), 'References')]"
        )
        // verify there are some references
        await page.waitForSelector('.panel__tabs-content .hierarchical-locations-view__item', { visible: true })
    }

    describe('External services', () => {
        test('External service add, edit, delete', async () => {
            const displayName = 'e2e-github-test-2'
            await ensureHasExternalService(
                'github',
                displayName,
                '{"url": "https://github.myenterprise.com", "token": "initial-token", "repositoryQuery": ["none"]}'
            )
            await page.goto(baseURL + '/site-admin/external-services')
            await (await page.waitForSelector(
                `[data-e2e-external-service-name="${displayName}"] .e2e-edit-external-service-button`
            )).click()

            // Type in a new external service configuration.
            await replaceText({
                selector: '.view-line',
                newText:
                    '{"url": "https://github.myenterprise.com", "token": "second-token", "repositoryQuery": ["none"]}',
                method: 'keyboard',
            })
            await page.click('.e2e-update-external-service-button')
            // Must wait for the operation to complete, or else a "Discard changes?" dialog will pop up
            await page.waitForSelector('.e2e-update-external-service-button:not([disabled])', { visible: true })

            await (await page.waitForSelector('.list-group-item[href="/site-admin/external-services"]', {
                visible: true,
            })).click()

            const accept = async (dialog: puppeteer.Dialog) => {
                await dialog.accept()
                page.off('dialog', accept)
            }
            page.on('dialog', accept)
            await (await page.waitForSelector(
                `[data-e2e-external-service-name="e2e-github-test-2"] .e2e-delete-external-service-button`,
                { visible: true }
            )).click()

            await page.waitFor(() => !document.querySelector('[data-e2e-external-service-name="e2e-github-test-2"]'))
        })
    })

    describe('Visual tests', () => {
        test('Repositories list', async () => {
            await page.goto(baseURL + '/site-admin/repositories?query=gorilla%2Fmux')
            await page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            await percySnapshot(page, 'Repositories list')
        })

        test('Search results repo', async () => {
            await page.goto(baseURL + '/search?q=repo:%5Egithub.com/gorilla/mux%24')
            await page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            // Flaky https://github.com/sourcegraph/sourcegraph/issues/2704
            // await percySnapshot(page, 'Search results repo')
        })

        test('Search results file', async () => {
            await page.goto(baseURL + '/search?q=repo:%5Egithub.com/gorilla/mux%24+file:%5Emux.go%24')
            await page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            // Flaky https://github.com/sourcegraph/sourcegraph/issues/2704
            // await percySnapshot(page, 'Search results file')
        })

        test('Search results code', async () => {
            await page.goto(baseURL + '/search?q=repo:^github.com/gorilla/mux$ file:mux.go "func NewRouter"')
            await page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            // Flaky https://github.com/sourcegraph/sourcegraph/issues/2704
            // await percySnapshot(page, 'Search results code')
        })
    })

    describe('Theme switcher', () => {
        test('changes the theme', async () => {
            await page.goto(baseURL + '/github.com/gorilla/mux/-/blob/mux.go')
            await page.waitForSelector('.theme', { visible: true })
            const currentThemes = await page.evaluate(() =>
                Array.from(document.querySelector('.theme')!.classList).filter(c => c.startsWith('theme-'))
            )
            expect(currentThemes).toHaveLength(1)
            await page.click('.e2e-user-nav-item-toggle')
            await page.select('.e2e-theme-toggle', 'dark')
            expect(
                await page.evaluate(() =>
                    Array.from(document.querySelector('.theme')!.classList).filter(c => c.startsWith('theme-'))
                )
            ).toEqual(['theme-dark'])
            await page.select('.e2e-theme-toggle', 'light')
            expect(
                await page.evaluate(() =>
                    Array.from(document.querySelector('.theme')!.classList).filter(c => c.startsWith('theme-'))
                )
            ).toEqual(['theme-light'])
        })
    })

    describe('Repository component', () => {
        const blobTableSelector = '.e2e-blob > table'
        /**
         * @param line 1-indexed line number
         * @param spanOffset 1-indexed index of the span that's to be clicked
         */
        const clickToken = async (line: number, spanOffset: number): Promise<void> => {
            const selector = `${blobTableSelector} tr:nth-child(${line}) > td.code > span:nth-child(${spanOffset})`
            await page.waitForSelector(selector, { visible: true })
            await page.click(selector)
        }

        // expectedCount defaults to one because of we haven't specified, we just want to ensure it exists at all
        const getHoverContents = async (expectedCount = 1): Promise<string[]> => {
            const selector =
                expectedCount > 1 ? `.e2e-tooltip-content:nth-child(${expectedCount})` : `.e2e-tooltip-content`
            await page.waitForSelector(selector, { visible: true })
            return await page.evaluate(() =>
                // You can't reference hoverContentSelector in puppeteer's page.evaluate
                Array.from(document.querySelectorAll('.e2e-tooltip-content')).map(t => t.textContent || '')
            )
        }
        const assertHoverContentContains = async (val: string, count?: number) => {
            expect(await getHoverContents(count)).toEqual(expect.arrayContaining([expect.stringContaining(val)]))
        }

        const clickHoverJ2D = async (): Promise<void> => {
            const selector = '.e2e-tooltip-go-to-definition'
            await page.waitForSelector(selector, { visible: true })
            await page.click(selector)
        }
        const clickHoverFindRefs = async (): Promise<void> => {
            const selector = '.e2e-tooltip-find-references'
            await page.waitForSelector(selector, { visible: true })
            await page.click(selector)
        }

        describe('file tree', () => {
            test('does navigation on file click', async () => {
                await page.goto(
                    baseURL + '/github.com/sourcegraph/godockerize@05bac79edd17c0f55127871fa9c6f4d91bebf07c'
                )
                await (await page.waitForSelector(`[data-tree-path="godockerize.go"]`, { visible: true })).click()
                await assertWindowLocation(
                    '/github.com/sourcegraph/godockerize@05bac79edd17c0f55127871fa9c6f4d91bebf07c/-/blob/godockerize.go'
                )
            })

            test('expands directory on row click (no navigation)', async () => {
                await page.goto(baseURL + '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')
                await page.waitForSelector('.tree__row-icon', { visible: true })
                await page.click('.tree__row-icon')
                await page.waitForSelector('.tree__row--selected [data-tree-path="websocket"]', { visible: true })
                await page.waitForSelector('.tree__row--expanded [data-tree-path="websocket"]', { visible: true })
                await assertWindowLocation('/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')
            })

            test('does navigation on directory row click', async () => {
                await page.goto(baseURL + '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')
                await page.waitForSelector('.tree__row-label', { visible: true })
                await page.click('.tree__row-label')
                await page.waitForSelector('.tree__row--selected [data-tree-path="websocket"]', { visible: true })
                await page.waitForSelector('.tree__row--expanded [data-tree-path="websocket"]', { visible: true })
                await assertWindowLocation(
                    '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d/-/tree/websocket'
                )
            })

            test('selects the current file', async () => {
                await page.goto(
                    baseURL +
                        '/github.com/sourcegraph/godockerize@05bac79edd17c0f55127871fa9c6f4d91bebf07c/-/blob/godockerize.go'
                )
                await page.waitForSelector('.tree__row--active [data-tree-path="godockerize.go"]', { visible: true })
            })

            test('shows partial tree when opening directory', async () => {
                await page.goto(
                    baseURL +
                        '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d/-/tree/websocket'
                )
                await page.waitForSelector('.tree__row', { visible: true })
                expect(await page.evaluate(() => document.querySelectorAll('.tree__row').length)).toEqual(1)
            })

            test('responds to keyboard shortcuts', async () => {
                const assertNumRowsExpanded = async (expectedCount: number) => {
                    expect(await page.evaluate(() => document.querySelectorAll('.tree__row--expanded').length)).toEqual(
                        expectedCount
                    )
                }

                await page.goto(
                    baseURL +
                        '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/.travis.yml'
                )
                await page.waitForSelector('.tree__row', { visible: true }) // waitForSelector for tree to render

                await page.click('.tree')
                await page.keyboard.press('ArrowUp') // arrow up to 'diff' directory
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff"]', { visible: true })
                await page.keyboard.press('ArrowRight') // arrow right (expand 'diff' directory)
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff"]', { visible: true })
                await page.waitForSelector('.tree__row--expanded [data-tree-path="diff"]', { visible: true })
                await page.waitForSelector('.tree__row [data-tree-path="diff/testdata"]', { visible: true })
                await page.keyboard.press('ArrowRight') // arrow right (move to nested 'diff/testdata' directory)
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', { visible: true })
                await assertNumRowsExpanded(1) // only `diff` directory is expanded, though `diff/testdata` is expanded

                await page.keyboard.press('ArrowRight') // arrow right (expand 'diff/testdata' directory)
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', { visible: true })
                await page.waitForSelector('.tree__row--expanded [data-tree-path="diff/testdata"]', { visible: true })
                await assertNumRowsExpanded(2) // `diff` and `diff/testdata` directories expanded

                await page.waitForSelector('.tree__row [data-tree-path="diff/testdata/empty.diff"]', { visible: true })
                // select some file nested under `diff/testdata`
                await page.keyboard.press('ArrowDown') // arrow down
                await page.keyboard.press('ArrowDown') // arrow down
                await page.keyboard.press('ArrowDown') // arrow down
                await page.keyboard.press('ArrowDown') // arrow down
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata/empty_orig.diff"]', {
                    visible: true,
                })

                await page.keyboard.press('ArrowLeft') // arrow left (navigate immediately up to parent directory `diff/testdata`)
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', { visible: true })
                await assertNumRowsExpanded(2) // `diff` and `diff/testdata` directories expanded

                await page.keyboard.press('ArrowLeft') // arrow left
                await page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', { visible: true }) // `diff/testdata` still selected
                await assertNumRowsExpanded(1) // only `diff` directory expanded
            })
        })

        describe('directory page', () => {
            // TODO(slimsag:discussions): temporarily disabled because the discussions feature flag removes this component.
            /*
            it('shows a row for each file in the directory', async () => {
                await page.goto(baseURL + '/github.com/gorilla/securecookie@e59506cc896acb7f7bf732d4fdf5e25f7ccd8983')
                await enableOrAddRepositoryIfNeeded()
                await page.waitForSelector('.tree-page__entries-directories', { visible: true })
                await retry(async () =>
                    assert.equal(
                        await page.evaluate(
                            () => document.querySelectorAll('.tree-page__entries-directories .tree-entry').length
                        ),
                        1
                    )
                )
                await retry(async () =>
                    assert.equal(
                        await page.evaluate(
                            () => document.querySelectorAll('.tree-page__entries-files .tree-entry').length
                        ),
                        7
                    )
                )
            })
            */

            test('shows commit information on a row', async () => {
                await page.goto(baseURL + '/github.com/gorilla/securecookie@e59506cc896acb7f7bf732d4fdf5e25f7ccd8983', {
                    waitUntil: 'domcontentloaded',
                })
                await page.waitForSelector('.git-commit-node__message', { visible: true })
                await retry(async () =>
                    expect(
                        await page.evaluate(() => document.querySelectorAll('.git-commit-node__message')[2].textContent)
                    ).toContain('Add fuzz testing corpus.')
                )
                await retry(async () =>
                    expect(
                        await page.evaluate(() =>
                            document.querySelectorAll('.git-commit-node-byline')[2].textContent!.trim()
                        )
                    ).toContain('Kamil Kisiel')
                )
                await retry(async () =>
                    expect(
                        await page.evaluate(() => document.querySelectorAll('.git-commit-node__oid')[2].textContent)
                    ).toEqual('c13558c')
                )
            })

            // TODO(slimsag:discussions): temporarily disabled because the discussions feature flag removes this component.
            /*
            it('navigates when clicking on a row', async () => {
                await page.goto(baseURL + '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')
                await enableOrAddRepositoryIfNeeded()
                // click on directory
                await page.waitForSelector('.tree-entry', { visible: true })
                await page.click('.tree-entry')
                await assertWindowLocation(
                    '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d/-/tree/websocket'
                )
            })
            */
        })

        describe('rev resolution', () => {
            test('shows clone in progress interstitial page', async () => {
                await page.goto(baseURL + '/github.com/sourcegraphtest/AlwaysCloningTest')
                await page.waitForSelector('.hero-page__subtitle', { visible: true })
                await retry(async () =>
                    expect(
                        await page.evaluate(() => document.querySelector('.hero-page__subtitle')!.textContent)
                    ).toEqual('Cloning in progress')
                )
            })

            test('resolves default branch when unspecified', async () => {
                await page.goto(baseURL + '/github.com/sourcegraph/go-diff/-/blob/diff/diff.go')
                await page.waitForSelector('.repo-header__rev', { visible: true })
                await retry(async () => {
                    expect(
                        await page.evaluate(() => document.querySelector('.repo-header__rev')!.textContent!.trim())
                    ).toEqual('master')
                })
                // Verify file contents are loaded.
                await page.waitForSelector(blobTableSelector)
            })

            test('updates rev with switcher', async () => {
                await page.goto(baseURL + '/github.com/sourcegraph/checkup/-/blob/s3.go')
                // Open rev switcher
                await page.waitForSelector('.repo-header__rev', { visible: true })
                await page.click('.repo-header__rev')
                // Click "Tags" tab
                await page.click('.revisions-popover .tab-bar__tab:nth-child(2)')
                await page.waitForSelector('a.git-ref-node[href*="0.1.0"]', { visible: true })
                await page.click('a.git-ref-node[href*="0.1.0"]')
                await assertWindowLocation('/github.com/sourcegraph/checkup@v0.1.0/-/blob/s3.go')
            })
        })

        describe('hovers', () => {
            describe(`Blob`, () => {
                test('gets displayed and updates URL when clicking on a token', async () => {
                    await page.goto(
                        baseURL + '/github.com/gorilla/mux@15a353a636720571d19e37b34a14499c3afa9991/-/blob/mux.go'
                    )
                    await page.waitForSelector(blobTableSelector)
                    await clickToken(24, 5)
                    await assertWindowLocation(
                        '/github.com/gorilla/mux@15a353a636720571d19e37b34a14499c3afa9991/-/blob/mux.go#L24:19'
                    )
                    await getHoverContents() // verify there is a hover
                    await percySnapshot(page, 'Code intel hover tooltip')
                })

                test('gets displayed when navigating to a URL with a token position', async () => {
                    await page.goto(
                        baseURL +
                            '/github.com/gorilla/mux@15a353a636720571d19e37b34a14499c3afa9991/-/blob/mux.go#L151:23'
                    )
                    await assertHoverContentContains(
                        `ErrMethodMismatch is returned when the method in the request does not match`
                    )
                })

                describe('jump to definition', () => {
                    test('noops when on the definition', async () => {
                        await page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                        await clickHoverJ2D()
                        await assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                    })

                    test('does navigation (same repo, same file)', async () => {
                        await page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L25:10'
                        )
                        await clickHoverJ2D()
                        return await assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                    })

                    test('does navigation (same repo, different file)', async () => {
                        await page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/print.go#L13:31'
                        )
                        await clickHoverJ2D()
                        await assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/diff.pb.go#L38:6'
                        )
                        // Verify file tree is highlighting the new path.
                        return await page.waitForSelector('.tree__row--active [data-tree-path="diff/diff.pb.go"]', {
                            visible: true,
                        })
                    })

                    // basic code intel doesn't support cross-repo jump-to-definition yet.
                    test.skip('does navigation (external repo)', async () => {
                        await page.goto(
                            baseURL +
                                '/github.com/sourcegraph/vcsstore@267289226b15e5b03adedc9746317455be96e44c/-/blob/server/diff.go#L27:30'
                        )
                        await clickHoverJ2D()
                        await assertWindowLocation(
                            '/github.com/sourcegraph/go-vcs@aa7c38442c17a3387b8a21f566788d8555afedd0/-/blob/vcs/repository.go#L103:6'
                        )
                    })
                })

                describe('find references', () => {
                    test('opens widget and fetches local references', async (): Promise<void> => {
                        jest.setTimeout(120000)

                        await page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                        await clickHoverFindRefs()
                        await assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6&tab=references'
                        )

                        await assertNonemptyLocalRefs()

                        // verify the appropriate # of references are fetched
                        await page.waitForSelector('.panel__tabs-content .file-match-children', { visible: true })
                        await retry(async () =>
                            expect(
                                await page.evaluate(
                                    () =>
                                        document.querySelectorAll('.panel__tabs-content .file-match-children__item')
                                            .length
                                )
                            ).toEqual(
                                // Basic code intel finds 8 references with some overlapping context, resulting in 4 hunks.
                                4
                            )
                        )

                        // verify all the matches highlight a `MultiFileDiffReader` token
                        await assertAllHighlightedTokens('MultiFileDiffReader')
                    })

                    // TODO unskip this once basic-code-intel looks for external
                    // references even when local references are found.
                    test.skip('opens widget and fetches external references', async () => {
                        await page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L32:16&tab=references'
                        )

                        // verify some external refs are fetched (we cannot assert how many, but we can check that the matched results
                        // look like they're for the appropriate token)
                        await assertNonemptyExternalRefs()

                        // verify all the matches highlight a `Reader` token
                        await assertAllHighlightedTokens('Reader')
                    })
                })
            })
        })

        describe.skip('godoc.org "Uses" links', () => {
            test('resolves standard library function', async () => {
                // https://godoc.org/bytes#Compare
                await page.goto(baseURL + '/-/godoc/refs?def=Compare&pkg=bytes&repo=')
                await assertWindowLocationPrefix('/github.com/golang/go/-/blob/src/bytes/bytes_decl.go')
                await assertStickyHighlightedToken('Compare')
                await assertNonemptyLocalRefs()
                await assertAllHighlightedTokens('Compare')
            })

            test('resolves standard library function (from stdlib repo)', async () => {
                // https://godoc.org/github.com/golang/go/src/bytes#Compare
                await page.goto(
                    baseURL +
                        '/-/godoc/refs?def=Compare&pkg=github.com%2Fgolang%2Fgo%2Fsrc%2Fbytes&repo=github.com%2Fgolang%2Fgo'
                )
                await assertWindowLocationPrefix('/github.com/golang/go/-/blob/src/bytes/bytes_decl.go')
                await assertStickyHighlightedToken('Compare')
                await assertNonemptyLocalRefs()
                await assertAllHighlightedTokens('Compare')
            })

            test('resolves external package function (from gorilla/mux)', async () => {
                // https://godoc.org/github.com/gorilla/mux#Router
                await page.goto(
                    baseURL + '/-/godoc/refs?def=Router&pkg=github.com%2Fgorilla%2Fmux&repo=github.com%2Fgorilla%2Fmux'
                )
                await assertWindowLocationPrefix('/github.com/gorilla/mux/-/blob/mux.go')
                await assertStickyHighlightedToken('Router')
                await assertNonemptyLocalRefs()
                await assertAllHighlightedTokens('Router')
            })
        })

        describe('external code host links', () => {
            test('on repo navbar ("View on GitHub")', async () => {
                await page.goto(
                    baseURL +
                        '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L19',
                    { waitUntil: 'domcontentloaded' }
                )
                await page.waitForSelector('.nav-link[href*="https://github"]', { visible: true })
                await retry(async () =>
                    expect(
                        await page.evaluate(
                            () =>
                                (document.querySelector('.nav-link[href*="https://github"]') as HTMLAnchorElement).href
                        )
                    ).toEqual(
                        'https://github.com/sourcegraph/go-diff/blob/3f415a150aec0685cb81b73cc201e762e075006d/diff/parse.go#L19'
                    )
                )
            })
        })
    })

    describe('Search component', () => {
        test('can execute search with search operators', async () => {
            await page.goto(baseURL + '/github.com/sourcegraph/go-diff')

            const operators: { [key: string]: string } = {
                repo: '^github.com/sourcegraph/go-diff$',
                count: '1000',
                type: 'file',
                file: '.go',
                '-file': '.md',
            }

            const operatorsQuery = Object.keys(operators)
                .map(op => `${op}:${operators[op]}`)
                .join('+')

            await page.goto(`${baseURL}/search?q=diff+${operatorsQuery}`)
            await page.waitForSelector('.e2e-search-results-stats', { visible: true })
            await retry(async () => {
                const label = await page.evaluate(
                    () => document.querySelector('.e2e-search-results-stats')!.textContent || ''
                )
                expect(label.includes('results')).toEqual(true)
            })
            await page.waitForSelector('.e2e-file-match-children-item', { visible: true })
        })

        test('renders results for sourcegraph/go-diff (no search group)', async () => {
            await page.goto(baseURL + '/github.com/sourcegraph/go-diff')
            await page.goto(
                baseURL + '/search?q=diff+repo:sourcegraph/go-diff%403f415a150aec0685cb81b73cc201e762e075006d+type:file'
            )
            await page.waitForSelector('.e2e-search-results-stats', { visible: true })
            await retry(async () => {
                const label = await page.evaluate(
                    () => document.querySelector('.e2e-search-results-stats')!.textContent || ''
                )
                expect(label.includes('results')).toEqual(true)
            })

            const firstFileMatchHref = await page.$eval(
                '.e2e-file-match-children-item',
                a => (a as HTMLAnchorElement).href
            )

            // navigate to result on click
            await page.click('.e2e-file-match-children-item')

            await retry(async () => {
                expect(await page.evaluate(() => window.location.href)).toEqual(firstFileMatchHref)
            })
        })

        test('accepts query for sourcegraph/jsonrpc2', async () => {
            await page.goto(baseURL + '/search')

            // Update the input value
            await page.waitForSelector('.e2e-query-input', { visible: true })
            await page.keyboard.type('test repo:sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')

            // TODO: test search scopes

            // Submit the search
            await page.click('.search-button')

            await page.waitForSelector('.e2e-search-results-stats', { visible: true })
            await retry(async () => {
                const label = await page.evaluate(
                    () => document.querySelector('.e2e-search-results-stats')!.textContent || ''
                )
                const match = /(\d+) results?/.exec(label)
                if (!match) {
                    throw new Error(
                        `.e2e-search-results-stats textContent did not match regex '(\d+) results': '${label}'`
                    )
                }
                const numberOfResults = parseInt(match[1], 10)
                expect(numberOfResults).toBeGreaterThan(0)
            })
        })
    })
})
