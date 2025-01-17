import { DiffPart } from '@sourcegraph/codeintellify'
import { Range } from '@sourcegraph/extension-api-classes'
import { uniqueId } from 'lodash'
import renderer from 'react-test-renderer'
import { BehaviorSubject, from, NEVER, Observable, of, Subject, Subscription, throwError } from 'rxjs'
import { filter, skip, switchMap, take } from 'rxjs/operators'
import { Services } from '../../../../shared/src/api/client/services'
import { integrationTestContext } from '../../../../shared/src/api/integration-test/testHelpers'
import { Controller } from '../../../../shared/src/extensions/controller'
import { SuccessGraphQLResult } from '../../../../shared/src/graphql/graphql'
import { IMutation, IQuery } from '../../../../shared/src/graphql/schema'
import { PlatformContext } from '../../../../shared/src/platform/context'
import { NOOP_TELEMETRY_SERVICE } from '../../../../shared/src/telemetry/telemetryService'
import { isDefined } from '../../../../shared/src/util/types'
import { DEFAULT_SOURCEGRAPH_URL } from '../../shared/util/context'
import { MutationRecordLike } from '../../shared/util/dom'
import { createGlobalDebugMount, createOverlayMount, FileInfo, handleCodeHost } from './code_intelligence'
import { toCodeViewResolver } from './code_views'

const RENDER = jest.fn()

const elementRenderedAtMount = (mount: Element): renderer.ReactTestRendererJSON | undefined => {
    const call = RENDER.mock.calls.find(call => call[1] === mount)
    return call && call[0]
}

jest.mock('uuid', () => ({
    v4: () => 'uuid',
}))

const createMockController = (services: Services): Controller => ({
    services,
    notifications: NEVER,
    executeCommand: jest.fn(),
    unsubscribe: jest.fn(),
})

const createMockPlatformContext = (
    partialMocks?: Partial<Pick<PlatformContext, 'forceUpdateTooltip' | 'sideloadedExtensionURL' | 'urlToFile'>>
): Pick<PlatformContext, 'forceUpdateTooltip' | 'sideloadedExtensionURL' | 'urlToFile' | 'requestGraphQL'> => ({
    forceUpdateTooltip: jest.fn(),
    urlToFile: jest.fn(),
    // Mock implementation of `requestGraphQL()` that returns successful
    // responses for `ResolveRev` and `BlobContent` queries, so that
    // code views can be resolved
    requestGraphQL: <R extends IQuery | IMutation>({
        request,
    }: {
        request: string
    }): Observable<SuccessGraphQLResult<R>> => {
        if (request.trim().startsWith('query SiteProductVersion')) {
            // tslint:disable-next-line: no-object-literal-type-assertion
            return of({
                data: {
                    site: {
                        productVersion: 'dev',
                        buildVersion: 'dev',
                        hasCodeIntelligence: true,
                    },
                },
                errors: undefined,
            } as SuccessGraphQLResult<R>)
        }
        if (request.trim().startsWith('query CurrentUser')) {
            // tslint:disable-next-line: no-object-literal-type-assertion
            return of({
                data: {
                    currentUser: {
                        id: 'u1',
                        displayName: 'Alice',
                        username: 'alice',
                        avatarURL: null,
                        url: 'https://example.com/alice',
                        settingsURL: 'https://example.com/alice/settings',
                        emails: [{ email: 'alice@example.com' }],
                        siteAdmin: false,
                    },
                },
                errors: undefined,
            } as SuccessGraphQLResult<R>)
        }
        if (request.trim().startsWith('query ResolveRev')) {
            // tslint:disable-next-line: no-object-literal-type-assertion
            return of({
                data: {
                    repository: {
                        mirrorInfo: {
                            cloned: true,
                        },
                        commit: {
                            oid: 'foo',
                        },
                    },
                },
                errors: undefined,
            } as SuccessGraphQLResult<R>)
        }
        if (request.trim().startsWith('query BlobContent')) {
            // tslint:disable-next-line: no-object-literal-type-assertion
            return of({
                data: {
                    repository: {
                        commit: {
                            file: {
                                content: 'Hello World',
                            },
                        },
                    },
                },
                errors: undefined,
            } as SuccessGraphQLResult<R>)
        }
        return throwError(new Error('GraphQL request failed'))
    },
    sideloadedExtensionURL: new Subject<string | null>(),
    ...partialMocks,
})

describe('code_intelligence', () => {
    beforeEach(() => {
        document.body.innerHTML = ''
    })

    describe('createOverlayMount()', () => {
        it('should create the overlay mount', () => {
            createOverlayMount('some-code-host')
            const mount = document.body.querySelector('.hover-overlay-mount')
            expect(mount).toBeDefined()
            expect(mount!.className).toBe('hover-overlay-mount hover-overlay-mount__some-code-host')
        })
    })

    describe('createGlobalDebugMount()', () => {
        it('should create the debug menu mount', () => {
            createGlobalDebugMount()
            const mount = document.body.querySelector('.global-debug')
            expect(mount).toBeDefined()
        })
    })

    describe('handleCodeHost()', () => {
        let subscriptions = new Subscription()

        afterEach(() => {
            RENDER.mockClear()
            subscriptions.unsubscribe()
            subscriptions = new Subscription()
        })

        const createTestElement = () => {
            const el = document.createElement('div')
            el.className = `test test-${uniqueId()}`
            document.body.appendChild(el)
            return el
        }

        test('renders the hover overlay mount', async () => {
            const { services } = await integrationTestContext()
            subscriptions.add(
                handleCodeHost({
                    mutations: of([{ addedNodes: [document.body], removedNodes: [] }]),
                    codeHost: {
                        name: 'test',
                        check: () => true,
                        codeViewResolvers: [],
                    },
                    extensionsController: createMockController(services),
                    showGlobalDebug: false,
                    platformContext: createMockPlatformContext(),
                    sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                    telemetryService: NOOP_TELEMETRY_SERVICE,
                    render: RENDER,
                })
            )
            const overlayMount = document.body.querySelector('.hover-overlay-mount')
            expect(overlayMount).toBeDefined()
            expect(overlayMount!.className).toBe('hover-overlay-mount hover-overlay-mount__test')
            const renderedOverlay = elementRenderedAtMount(overlayMount!)
            expect(renderedOverlay).not.toBeUndefined()
        })

        test('renders the command palette if codeHost.getCommandPaletteMount is defined', async () => {
            const { services } = await integrationTestContext()
            const commandPaletteMount = createTestElement()
            subscriptions.add(
                handleCodeHost({
                    mutations: of([{ addedNodes: [document.body], removedNodes: [] }]),
                    codeHost: {
                        name: 'test',
                        check: () => true,
                        getCommandPaletteMount: () => commandPaletteMount,
                        codeViewResolvers: [],
                    },
                    extensionsController: createMockController(services),
                    showGlobalDebug: false,
                    platformContext: createMockPlatformContext(),
                    sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                    telemetryService: NOOP_TELEMETRY_SERVICE,
                    render: RENDER,
                })
            )
            const renderedCommandPalette = elementRenderedAtMount(commandPaletteMount)
            expect(renderedCommandPalette).not.toBeUndefined()
        })

        test('creates a .global-debug element and renders the debug menu if showGlobalDebug is true', async () => {
            const { services } = await integrationTestContext()
            subscriptions.add(
                handleCodeHost({
                    mutations: of([{ addedNodes: [document.body], removedNodes: [] }]),
                    codeHost: {
                        name: 'test',
                        check: () => true,
                        codeViewResolvers: [],
                    },
                    extensionsController: createMockController(services),
                    showGlobalDebug: true,
                    platformContext: createMockPlatformContext(),
                    sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                    telemetryService: NOOP_TELEMETRY_SERVICE,
                    render: RENDER,
                })
            )
            const globalDebugMount = document.body.querySelector('.global-debug')
            expect(globalDebugMount).toBeDefined()
            const renderedDebugElement = elementRenderedAtMount(globalDebugMount!)
            expect(renderedDebugElement).toBeDefined()
        })

        test('detects code views based on selectors', async () => {
            const { services } = await integrationTestContext(undefined, { roots: [], editors: [] })
            const codeView = createTestElement()
            codeView.id = 'code'
            const toolbarMount = document.createElement('div')
            codeView.appendChild(toolbarMount)
            const fileInfo: FileInfo = {
                repoName: 'foo',
                filePath: '/bar.ts',
                commitID: '1',
            }
            subscriptions.add(
                handleCodeHost({
                    mutations: of([{ addedNodes: [document.body], removedNodes: [] }]),
                    codeHost: {
                        name: 'test',
                        check: () => true,
                        codeViewResolvers: [
                            toCodeViewResolver('#code', {
                                dom: {
                                    getCodeElementFromTarget: jest.fn(),
                                    getCodeElementFromLineNumber: jest.fn(),
                                    getLineElementFromLineNumber: jest.fn(),
                                    getLineNumberFromCodeElement: jest.fn(),
                                },
                                resolveFileInfo: codeView => of(fileInfo),
                                getToolbarMount: () => toolbarMount,
                            }),
                        ],
                    },
                    extensionsController: createMockController(services),
                    showGlobalDebug: true,
                    platformContext: createMockPlatformContext(),
                    sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                    telemetryService: NOOP_TELEMETRY_SERVICE,
                    render: RENDER,
                })
            )
            const editors = await from(services.editor.editors)
                .pipe(
                    skip(1),
                    take(1)
                )
                .toPromise()
            expect(editors).toEqual([
                {
                    editorId: 'editor#0',
                    isActive: true,
                    resource: 'git://foo?1#/bar.ts',
                    model: {
                        uri: 'git://foo?1#/bar.ts',
                        text: 'Hello World',
                        languageId: 'typescript',
                    },
                    selections: [],
                    type: 'CodeEditor',
                },
            ])
            expect(codeView.classList.contains('sg-mounted')).toBe(true)
            const toolbar = elementRenderedAtMount(toolbarMount)
            expect(toolbar).not.toBeUndefined()
        })

        describe('Decorations', () => {
            it('decorates a code view', async () => {
                const { extensionAPI, services } = await integrationTestContext(undefined, {
                    roots: [],
                    editors: [],
                })
                const codeView = createTestElement()
                codeView.id = 'code'
                const fileInfo: FileInfo = {
                    repoName: 'foo',
                    filePath: '/bar.ts',
                    commitID: '1',
                }
                // For this test, we pretend bar.ts only has one line of code
                const line = document.createElement('div')
                codeView.appendChild(line)
                subscriptions.add(
                    handleCodeHost({
                        mutations: of([{ addedNodes: [document.body], removedNodes: [] }]),
                        codeHost: {
                            name: 'test',
                            check: () => true,
                            codeViewResolvers: [
                                toCodeViewResolver('#code', {
                                    dom: {
                                        getCodeElementFromTarget: () => line,
                                        getCodeElementFromLineNumber: () => line,
                                        getLineElementFromLineNumber: () => line,
                                        getLineNumberFromCodeElement: () => 1,
                                    },
                                    resolveFileInfo: codeView => of(fileInfo),
                                }),
                            ],
                        },
                        extensionsController: createMockController(services),
                        showGlobalDebug: true,
                        platformContext: createMockPlatformContext(),
                        sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                        telemetryService: NOOP_TELEMETRY_SERVICE,
                        render: RENDER,
                    })
                )
                const activeEditor = await from(extensionAPI.app.activeWindowChanges)
                    .pipe(
                        filter(isDefined),
                        switchMap(window => window.activeViewComponentChanges),
                        filter(isDefined),
                        take(1)
                    )
                    .toPromise()
                const decorationType = extensionAPI.app.createDecorationType()
                const decorated = () =>
                    services.textDocumentDecoration
                        .getDecorations({ uri: 'git://foo?1#/bar.ts' })
                        .pipe(
                            filter(decorations => Boolean(decorations && decorations.length > 0)),
                            take(1)
                        )
                        .toPromise()

                // Set decorations and verify that a decoration attachment has been added
                activeEditor.setDecorations(decorationType, [
                    {
                        range: new Range(0, 0, 0, 0),
                        after: {
                            contentText: 'test decoration',
                        },
                    },
                ])
                await decorated()
                expect(line.querySelectorAll('.line-decoration-attachment')).toHaveLength(1)
                expect(line.querySelector('.line-decoration-attachment')!.textContent).toEqual('test decoration')

                // Decorate the code view again, and verify that previous decorations
                // are cleaned up and replaced by the new decorations.
                activeEditor.setDecorations(decorationType, [
                    {
                        range: new Range(0, 0, 0, 0),
                        after: {
                            contentText: 'test decoration 2',
                        },
                    },
                ])
                await decorated()
                expect(line.querySelectorAll('.line-decoration-attachment').length).toBe(1)
                expect(line.querySelector('.line-decoration-attachment')!.textContent).toEqual('test decoration 2')
            })

            it('decorates a diff code view', async () => {
                const { extensionAPI, services } = await integrationTestContext(undefined, {
                    roots: [],
                    editors: [],
                })
                const codeView = createTestElement()
                codeView.id = 'code'
                const fileInfo: FileInfo = {
                    repoName: 'foo',
                    filePath: '/bar.ts',
                    commitID: '2',
                    baseRepoName: 'foo',
                    baseFilePath: '/bar.ts',
                    baseCommitID: '1',
                }
                codeView.innerHTML =
                    '<div line="1" part="head"><span class="code-element"></span></div>\n' +
                    '<div line="2" part="base"><span class="code-element"></span></div>\n' +
                    '<div line="2" part="head"><span class="code-element"></span></div>\n' +
                    '<div line="4" part="head"><span class="code-element"></span></div>\n' +
                    '<div line="5" part="base"><span class="code-element"></span></div>\n'
                const dom = {
                    getCodeElementFromTarget: (target: HTMLElement) => target.closest('.code-element') as HTMLElement,
                    getCodeElementFromLineNumber: (codeView: HTMLElement, line: number, part?: DiffPart) =>
                        codeView.querySelector<HTMLElement>(`[line="${line}"][part="${part}"] > .code-element`),
                    getLineElementFromLineNumber: (codeView: HTMLElement, line: number, part?: DiffPart) =>
                        codeView.querySelector<HTMLElement>(`[line="${line}"][part="${part}"]`),
                    getLineNumberFromCodeElement: (codeElement: HTMLElement) =>
                        parseInt(codeElement.parentElement!.getAttribute('line')!, 10),
                }
                subscriptions.add(
                    handleCodeHost({
                        mutations: of([{ addedNodes: [document.body], removedNodes: [] }]),
                        codeHost: {
                            name: 'test',
                            check: () => true,
                            codeViewResolvers: [
                                toCodeViewResolver('#code', {
                                    dom,
                                    resolveFileInfo: () => of(fileInfo),
                                }),
                            ],
                        },
                        extensionsController: createMockController(services),
                        showGlobalDebug: true,
                        platformContext: createMockPlatformContext({}),
                        sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                        telemetryService: NOOP_TELEMETRY_SERVICE,
                        render: RENDER,
                    })
                )
                await from(extensionAPI.app.activeWindowChanges)
                    .pipe(
                        filter(isDefined),
                        switchMap(window => window.activeViewComponentChanges),
                        filter(isDefined),
                        take(2)
                    )
                    .toPromise()
                const decorationType = extensionAPI.app.createDecorationType()
                const decorated = (commit: string) =>
                    services.textDocumentDecoration
                        .getDecorations({ uri: `git://foo?${commit}#/bar.ts` })
                        .pipe(
                            skip(1),
                            take(1)
                        )
                        .toPromise()

                // Set decorations and verify that a decoration attachment has been added
                const editors = extensionAPI.app.activeWindow!.visibleViewComponents
                expect(editors).toHaveLength(2)

                const baseEditor = editors.find(e => e.document.uri === 'git://foo?1#/bar.ts')!
                const baseDecorations = [
                    {
                        range: new Range(0, 0, 0, 0),
                        isWholeLine: true,
                        backgroundColor: 'red',
                        after: {
                            contentText: 'test decoration base line 1',
                        },
                    },
                    {
                        range: new Range(1, 0, 1, 0),
                        isWholeLine: true,
                        backgroundColor: 'red',
                        after: {
                            contentText: 'test decoration base line 2',
                        },
                    },
                    {
                        range: new Range(4, 0, 4, 0),
                        isWholeLine: true,
                        backgroundColor: 'red',
                        after: {
                            contentText: 'test decoration base line 5',
                        },
                    },
                ]
                baseEditor.setDecorations(decorationType, baseDecorations)

                const headEditor = editors.find(e => e.document.uri === 'git://foo?2#/bar.ts')!
                const headDecorations = [
                    {
                        range: new Range(0, 0, 0, 0),
                        isWholeLine: true,
                        after: {
                            contentText: 'test decoration head line 1',
                        },
                    },
                    {
                        range: new Range(1, 0, 1, 0),
                        isWholeLine: true,
                        backgroundColor: 'blue',
                        after: {
                            contentText: 'test decoration head line 2',
                        },
                    },
                    {
                        range: new Range(6, 0, 6, 0),
                        isWholeLine: true,
                        after: {
                            contentText: 'test decoration not visible',
                        },
                    },
                ]
                headEditor.setDecorations(decorationType, headDecorations)

                await Promise.all([decorated('1'), decorated('2')])

                expect(codeView).toMatchSnapshot()

                // Decorate the code view again, and verify that previous decorations
                // are cleaned up and replaced by the new decorations.
                // Remove decoration in first and second line
                baseEditor.setDecorations(decorationType, baseDecorations.slice(2))
                await decorated('1')
                expect(codeView).toMatchSnapshot()

                // Change decoration in first line
                headEditor.setDecorations(decorationType, [
                    headDecorations[0],
                    {
                        ...headDecorations[1],
                        after: {
                            ...headDecorations[1].after,
                            contentText: 'test decoration head line 2 changed',
                        },
                    },
                    headDecorations[2],
                ])
                await decorated('2')
                expect(codeView).toMatchSnapshot()
            })
        })

        test('removes code views and models', async () => {
            const { services } = await integrationTestContext(undefined, {
                roots: [],
                editors: [],
            })
            const codeView1 = createTestElement()
            codeView1.className = 'code'
            const codeView2 = createTestElement()
            codeView2.className = 'code'
            const fileInfo: FileInfo = {
                repoName: 'foo',
                filePath: '/bar.ts',
                commitID: '1',
            }
            const mutations = new BehaviorSubject<MutationRecordLike[]>([
                { addedNodes: [document.body], removedNodes: [] },
            ])
            subscriptions.add(
                handleCodeHost({
                    mutations,
                    codeHost: {
                        name: 'test',
                        check: () => true,
                        codeViewResolvers: [
                            toCodeViewResolver('.code', {
                                dom: {
                                    getCodeElementFromTarget: jest.fn(),
                                    getCodeElementFromLineNumber: jest.fn(),
                                    getLineElementFromLineNumber: jest.fn(),
                                    getLineNumberFromCodeElement: jest.fn(),
                                },
                                resolveFileInfo: codeView => of(fileInfo),
                            }),
                        ],
                    },
                    extensionsController: createMockController(services),
                    showGlobalDebug: true,
                    platformContext: createMockPlatformContext(),
                    sourcegraphURL: DEFAULT_SOURCEGRAPH_URL,
                    telemetryService: NOOP_TELEMETRY_SERVICE,
                    render: RENDER,
                })
            )
            let editors = await from(services.editor.editors)
                .pipe(
                    skip(2),
                    take(1)
                )
                .toPromise()
            expect(editors).toEqual([
                {
                    editorId: 'editor#0',
                    isActive: true,
                    model: {
                        languageId: 'typescript',
                        text: 'Hello World',
                        uri: 'git://foo?1#/bar.ts',
                    },
                    resource: 'git://foo?1#/bar.ts',
                    selections: [],
                    type: 'CodeEditor',
                },
                {
                    editorId: 'editor#1',
                    isActive: true,
                    model: {
                        languageId: 'typescript',
                        text: 'Hello World',
                        uri: 'git://foo?1#/bar.ts',
                    },
                    resource: 'git://foo?1#/bar.ts',
                    selections: [],
                    type: 'CodeEditor',
                },
            ])
            expect(services.model.hasModel('git://foo?1#/bar.ts')).toBe(true)
            // Simulate codeView1 removal
            mutations.next([{ addedNodes: [], removedNodes: [codeView1] }])
            // One editor should have been removed, model should still exist
            editors = await from(services.editor.editors)
                .pipe(
                    skip(1),
                    take(1)
                )
                .toPromise()
            expect(editors).toEqual([
                {
                    editorId: 'editor#1',
                    isActive: true,
                    model: {
                        languageId: 'typescript',
                        text: 'Hello World',
                        uri: 'git://foo?1#/bar.ts',
                    },
                    resource: 'git://foo?1#/bar.ts',
                    selections: [],
                    type: 'CodeEditor',
                },
            ])
            expect(services.model.hasModel('git://foo?1#/bar.ts')).toBe(true)
            // Simulate codeView2 removal
            mutations.next([{ addedNodes: [], removedNodes: [codeView2] }])
            // Second editor and model should have been removed
            editors = await from(services.editor.editors)
                .pipe(
                    skip(1),
                    take(1)
                )
                .toPromise()
            expect(editors).toEqual([])
            expect(services.model.hasModel('git://foo?1#/bar.ts')).toBe(false)
        })
    })
})
