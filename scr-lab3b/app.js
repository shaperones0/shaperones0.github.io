

const elBtnLoad = document.getElementById('btn-load')
const elBtnLoad_defaultText = elBtnLoad.textContent
const elUsers = document.getElementById('div-users')
const elFilter = document.getElementById('text-filter')

const elLogs = document.getElementById('logs')

const tmpUser = document.getElementById('tmp-user')
const tmpPub = document.getElementById('tmp-pub')

const wlog = (msg) => {
    elLogs.textContent += `\n> ${msg}`
}

let filter = ""
const users = []
const objUserCreate = (id, name, email, city, pubs=[], open=0) => {
    return {
        id: id,
        name: name,
        email: email,
        city: city,
        pubs: pubs,
        open: open
    }
}

const objUserFromTypicode = (user) => {
    return objUserCreate(
        user['id'],
        user['name'],
        user['email'],
        user['address']['city']
    )
}

const objPubCreate = (title, body) => {
    return {
        title: title,
        body: body
    }
}

const objPubFromTypicode = (pub) => {
    return {
        title: pub.title,
        body: pub.body
    }
}

const uiUpdate = () => {
    elUsers.innerHTML = '';

    let usersMatched = 0;
    for (const user of users) {
        //check filter
        if (filter !== "") {
            if (!user.name.includes(filter)) continue
        }
        usersMatched++;

        //create them divs
        const elUser = tmpUser.content.firstElementChild.cloneNode(true)
        const elDetail = elUser.querySelector('details')

        const elTitle = elUser.querySelector('.user-title')
        elTitle.textContent = userSummaryContent(user)


        if (user.pubs.length !== 0 && user.open) {
            elDetail.open = true
        }
        const elContent = elUser.querySelector('.user-content')
        for (const post of user.pubs) {
            const elPub = tmpPub.content.firstElementChild.cloneNode(true)

            const elPubTitle = elPub.querySelector('.pub-title')
            elPubTitle.textContent = post.title
            const elPubContent = elPub.querySelector('.pub-content')
            elPubContent.textContent = post.body

            elContent.appendChild(elPub)
        }


        elDetail.addEventListener('toggle', () => {
            if (elDetail.open) {
                user.open = true
                //check if empty posts
                if (user.pubs.length === 0) {
                    //fetch
                    fetchUserPosts(user, elTitle)
                }
            }
            else {
                user.open = false
            }
        })

        elUsers.appendChild(elUser)
    }

    if (usersMatched === 0 && users.length > 0) [
        elUsers.innerText = 'Пользователи не найдены :('
    ]
}

const userSummaryContent = (user, append = null) => {
    if (append === null) {
        return `${user.name} (${user.email}) | ${user.city}`
    }
    return `${user.name} (${user.email}) | ${user.city} --- ${append}`
}

const fetchUsers = async () => {
    elBtnLoad.textContent = 'Загрузка...'
    elBtnLoad.disabled = true

    const response = await fetch(
        'https://jsonplaceholder.typicode.com/users',
    )

    if (!response.ok) {
        const message = response.status === 404 ? `Сервер не найден` : `Произошла ошибка ${response.status}...`
        elBtnLoad.textContent = message
        elBtnLoad.disabled = false
        wlog(`Ошибка HTTP ${response.status}`)
        return
    }

    const json = await response.json()

    elBtnLoad.textContent = elBtnLoad_defaultText
    elBtnLoad.disabled = false

    wlog(`Успех! Получено ${json.length} пользователей`)

    //push into the thinhg
    users.length = 0
    for (const user of json) {
        users.push(objUserFromTypicode(user))
    }

    uiUpdate()
}

const fetchUserPosts = async (user, elSummary) => {
    elSummary.textContent = userSummaryContent(user, 'Загрузка...')
    elSummary.disabled = true


    const params = new URLSearchParams();
    params.append("userId", user.id);

    const response = await fetch(`https://jsonplaceholder.typicode.com/posts?${params}`)

    if (!response.ok) {
        elSummary.textContent = userSummaryContent(user, 'Что-то пошло не так...')
        elSummary.disabled = false
        wlog(`Ошибка ${response.status}`)
        return
    }

    const json = await response.json()

    wlog(`Успех! Получено ${json.length} записей`)

    //push into the thinhg
    user.pubs.length = 0
    for (const pub of json.slice(0, 3)) {
        user.pubs.push(objPubFromTypicode(pub))
    }

    uiUpdate()
}

window.onload = () => {

    elBtnLoad.addEventListener('click', fetchUsers)
    elFilter.addEventListener('input', () => {
        filter = elFilter.value
        uiUpdate()
    })

    uiUpdate()
}