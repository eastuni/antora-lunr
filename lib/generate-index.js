'use strict'

const lunr = require('lunr')
const cheerio = require('cheerio')
const Entities = require('html-entities').AllHtmlEntities
const entities = new Entities()

/**
 * Generate a Lunr index.
 *
 * Iterates over the specified pages and creates a Lunr index.
 *
 * @memberof generate-index
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Array<File>} pages - The publishable pages to map.
 * @param {Object} contentCatalog - the Antora content catalog (allows access to page metadata).
 * @param {Object} env - command line environment variables.
 * @returns {Object} A JSON object with a Lunr index and a documents store.
 */
function generateIndex (playbook, pages, contentCatalog, env) {
  let siteUrl = playbook.site.url
  if (!siteUrl) {
    // Uses relative links when site URL is not set
    siteUrl = ''
  }
  if (siteUrl.charAt(siteUrl.length - 1) === '/') siteUrl = siteUrl.substr(0, siteUrl.length - 1)
  if (!pages.length) return {}
  // Map of Lunr ref to document
  const documentsStore = {}
  const documents = pages
    .map((page) => {
      const html = page.contents.toString()
      const $ = cheerio.load(html)
      return { page, $ }
    })
    // Exclude pages marked as "noindex"
    .filter(({ page, $ }) => {
      const $metaRobots = $('meta[name=robots]')

      const metaRobotNoIndex = $metaRobots && $metaRobots.attr('content') === 'noindex'
      const pageNoIndex = page.asciidoc && page.asciidoc.attributes && page.asciidoc.attributes.noindex === ''
      const noIndex = metaRobotNoIndex || pageNoIndex
      const indexOnlyLatest = env.DOCSEARCH_INDEX_VERSION &&
                              env.DOCSEARCH_INDEX_VERSION === 'latest'
      if (indexOnlyLatest) {
        const component = contentCatalog.getComponent(page.src.component)
        const thisVersion = contentCatalog.getComponentVersion(component, page.src.version)
        const latestVersion = contentCatalog.getComponent(page.src.component).latest
        const notLatest = thisVersion !== latestVersion
        return !(noIndex || notLatest)
      }
      return !noIndex
    })
    .map(({ page, $ }) => {
      // Fetch just the article content, so we don't index the TOC and other on-page text
      // Remove any found headings, to improve search results
      const article = $('article.doc')
      const $h1 = $('h1', article)
      const documentTitle = $h1.first().text()
      $h1.remove()
      const titles = []
      $('h2,h3,h4,h5,h6', article).each(function () {
        const $title = $(this)
        // If the title does not have an Id then Lunr will throw a TypeError
        // cannot read property 'text' of undefined.
        if ($title.attr('id')) {
          titles.push({
            text: $title.text(),
            id: $title.attr('id')
          })
        }
        $title.remove()
      })

      // don't index navigation elements for pagination on each page
      // as these are the titles of other pages and it would otherwise pollute the index.
      $('nav.pagination', article).each(function () {
        $(this).remove()
      })

      // Pull the text from the article, and convert entities
      let text = article.text()
      // Decode HTML
      text = entities.decode(text)
      // Strip HTML tags
      text = text.replace(/(<([^>]+)>)/ig, '')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      // Return the indexable content, organized by type
      return {
        text: text,
        title: documentTitle,
        component: page.src.component,
        version: page.src.version,
        name: page.src.stem,
        url: page.pub.url,
        titles: titles // TODO get title id to be able to use fragment identifier
      }
    })
  const languages = env.DOCSEARCH_LANGS
  ? env.DOCSEARCH_LANGS.split(',')
  : ['en']

  if (languages.length > 1 || !languages.includes('en')) {
    if (languages.length > 1 && typeof lunr.multiLanguage === 'undefined') {
      // required, otherwise lunr.multiLanguage will be undefined
      require('@eastuni/lunr-languages-ko/lunr.multi')(lunr)
    }
    // required, to load additional languages
    require('@eastuni/lunr-languages-ko/lunr.stemmer.support')(lunr)
    languages.forEach((language) => {
      if (language === 'ja' && typeof lunr.TinySegmenter === 'undefined') {
        require('@eastuni/lunr-languages-ko/tinyseg')(lunr) // needed for Japanese Support
      }

      if (language === 'th' && typeof lunr.wordcut === 'undefined') {
        lunr.wordcut = require('@eastuni/lunr-languages-ko/wordcut') // needed for Thai support
      }

      if (language !== 'en' && typeof lunr[language] === 'undefined') {
        require('@eastuni/lunr-languages-ko/lunr.'+language)(lunr)
      }
    })
  }


    
  // Construct the lunr index from the composed content
  const lunrIndex = lunr(function () {
    const self = this
    if (languages.length > 1) {
      self.use(lunr.multiLanguage(...languages))
    } else if (!languages.includes('en')) {
      self.use(lunr[languages[0]])
    } else {
      // default language (English)
    }
    self.ref('url')
    self.field('title', { boost: 10 })
    self.field('name')
    self.field('text')
    self.field('component')
    self.metadataWhitelist = ['position']
    documents.forEach(function (doc) {
      self.add(doc)
      doc.titles.forEach(function (title) {
        self.add({
          title: title.text,
          url: `${doc.url}#${title.id}`
        })
      }, self)
    }, self)
  })

  // Place all indexed documents into the store
  documents.forEach(function (doc) {
    documentsStore[doc.url] = doc
  })

  // Return the completed index, store, and component map
  return {
    index: lunrIndex,
    store: documentsStore
  }
}

// Helper function allowing Antora to create a site asset containing the index
function createIndexFile (index) {
  return {
    mediaType: 'text/javascript',
    contents: Buffer.from(`window.antoraLunr.init(${JSON.stringify(index)})`),
    src: { stem: 'search-index' },
    out: { path: 'search-index.js' },
    pub: { url: '/search-index.js', rootPath: '' }
  }
}

module.exports = generateIndex
module.exports.createIndexFile = createIndexFile
