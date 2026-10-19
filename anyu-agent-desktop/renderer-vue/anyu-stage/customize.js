(() => {
  /* ANYU_SKIP_LOADING_UI */
  document.getElementById('loading-overlay')?.remove()
  const requestedInitialState = new URLSearchParams(window.location.search).get('initial')
  const routeDefinitions = [
    { label: '模型广场', href: '/models' },
    { label: '稳定号池', href: '/pools/stable' },
    { label: '特价号池', href: '/pools/discount' },
    { label: '控制台', href: '/login' },
  ]

  window.history.replaceState({ anyuStage: true }, '', '/')
  document.documentElement.lang = 'zh-CN'
  document.title = 'ANYU · 智能中转站'
  document.body.dataset.anyuCoreOnly = 'true'

  const initialSectionName = requestedInitialState === 'vision' ? 'vision' : 'mission_in'
  const initialProgress = requestedInitialState === 'vision' ? 0.16 : 0.9
  const initialSection = document.querySelector(`[data-top_section="${initialSectionName}"]`)
  if (initialSection) {
    const top = initialSection.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, Math.round(top + initialSection.offsetHeight * initialProgress))
  }

  const coreSections = new Set(['mission_in', 'mission', 'vision'])
  document.querySelectorAll('[data-top_section]').forEach((section) => {
    const name = section.getAttribute('data-top_section')
    if (name && !coreSections.has(name)) {
      section.setAttribute('aria-hidden', 'true')
      section.style.setProperty('visibility', 'hidden', 'important')
      section.style.setProperty('pointer-events', 'none', 'important')
    }
  })

  document.querySelectorAll('[data-top_works_item]').forEach((item) => {
    item.setAttribute('data-top_works_item', '/top/logo.png')
  })

  document.querySelectorAll('.TopScrollIndicator__section_item').forEach((item) => {
    const name = item.getAttribute('data-section')
    if (name && !['mission', 'vision'].includes(name)) {
      item.style.setProperty('display', 'none', 'important')
    }
  })

  const setText = (selector, value) => {
    const element = document.querySelector(selector)
    if (element) element.textContent = value
  }

  const configureLink = (link, label, href) => {
    if (!link) return
    link.href = href
    link.target = '_top'
    link.dataset.anyuRoute = 'true'
    const text = link.querySelector('span') || link
    text.textContent = label
  }

  const logoLink = document.querySelector('.Header__logo a')
  if (logoLink) {
    logoLink.href = '/home'
    logoLink.target = '_top'
    logoLink.dataset.anyuRoute = 'true'
    logoLink.innerHTML = '<span class="anyu-stage-brand">ANYU</span>'
  }

  document.querySelectorAll('.Header__nav_item a').forEach((link, index) => {
    const definition = routeDefinitions[index]
    if (definition) configureLink(link, definition.label, definition.href)
  })

  const contactLink = document.querySelector('.Header__contact')
  if (contactLink) {
    contactLink.href = '/login'
    contactLink.target = '_top'
    contactLink.dataset.anyuRoute = 'true'
    contactLink.querySelectorAll('span').forEach((span) => {
      if (!span.classList.contains('SlotButton__text_wrapper')) span.textContent = '登录 / 注册'
    })
  }

  const sideMenuLinks = [...document.querySelectorAll('.SideMenu__menu_item a')]
  const sideMenuDefinitions = [
    { label: '首页', href: '/home' },
    ...routeDefinitions,
    { label: '登录 / 注册', href: '/login' },
  ]
  sideMenuLinks.forEach((link, index) => {
    const definition = sideMenuDefinitions[index]
    if (definition) configureLink(link, definition.label, definition.href)
  })

  setText('[data-section="mission"] [data-section-label]', '智能中转')
  setText('[data-section="vision"] [data-section-label]', '连接愿景')
  setText('[data-mission-text] [data-marker-0]', '汇聚全球前沿模型')
  setText('[data-mission-text] [data-marker-1]', '让每一次智能调用更稳定、更透明')
  setText('[data-mission-text] [data-marker-2]', '也更自由')
  setText('[data-mission-text_en]', '统一连接模型、密钥与额度，让复杂调用回归简单。')
  setText('[data-vision-text] [data-marker-0]', '以稳定的连接，承载持续的创造')
  setText('[data-vision-text] [data-marker-1]', '让智能触手可及')
  setText('[data-vision-text_en]', '面向每一次灵感，为开发者与团队提供清晰、可靠的人工智能基础设施。')
  setText('#loading-text', '连接模型 · 正在构建稳定路由')

  document.addEventListener('click', (event) => {
    const target = event.target
    const link = target instanceof Element ? target.closest('[data-anyu-route="true"]') : null
    if (!link) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const href = link.getAttribute('href') || '/home'
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'anyu:navigate', href }, window.location.origin)
      return
    }
    window.location.assign(href)
  }, true)

  document.addEventListener('mouseenter', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.Header__nav_item, .SideMenu__menu_item')) {
      event.stopImmediatePropagation()
    }
  }, true)

  document.body.dataset.anyuLocalized = 'true'
})()
